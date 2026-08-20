#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["boto3"]
# ///
"""Copy the local blob store into S3 — the boto3 stand-in for `aws s3 cp --recursive`.

The local backend stores objects at {STORAGE_ROOT}/{bucket}/{key}; S3 stores them
at s3://{bucket}/{key}. So the BUCKET DIRECTORY LEVEL IS DROPPED:

    ./storage/voice-records/260731/sc-1306/0.webm
        -> s3://cdacchndstvals3arc-b1/260731/sc-1306/0.webm

Run it from the repo root. Credentials come from the environment or .env — the
script never asks you to put them on the command line (shell history) or in the
file (git). Any of these work:

    export AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...
    # or put the same two keys in .env  (read automatically)
    # or leave both unset and it will prompt, hidden

Usage (uv resolves boto3 from the inline metadata above — no venv needed):
    uv run scripts/upload_storage_to_s3.py --dry-run         # preview, uploads nothing
    uv run scripts/upload_storage_to_s3.py                   # upload, skipping identical objects
    uv run scripts/upload_storage_to_s3.py --verify-only     # compare local vs remote

    # the second directory (system_details blobs)
    uv run scripts/upload_storage_to_s3.py \
        --root ./storage/voice-records-batch --bucket <non-vaded-bucket>

    # inside the pod, where boto3 is already installed and there is no uv:
    /app/.venv/bin/python scripts/upload_storage_to_s3.py
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

DEFAULT_ENDPOINT = "https://cdacchndstvals3arc.ipstorage.tatacommunications.com"
DEFAULT_BUCKET = "cdacchndstvals3arc-b1"
DEFAULT_ROOT = "./storage/voice-records"
DEFAULT_REGION = "ap-south-1"

# mimetypes does not know webm/m4a on every platform, and a wrong Content-Type
# breaks in-browser playback of presigned GETs.
CONTENT_TYPES = {
    ".webm": "audio/webm", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
    ".wav": "audio/wav", ".ogg": "audio/ogg", ".aac": "audio/aac",
    ".mp4": "video/mp4", ".flac": "audio/flac",
    ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown",
}

_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024.0
    return f"{n}B"


def load_env_file(path: Path) -> None:
    """Fill in AWS_* from .env without clobbering the real environment.
    Tolerates the repo's quoted values and duplicate keys (last one wins,
    same as the app's loader)."""
    if not path.is_file():
        return
    wanted = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
              "S3_ENDPOINT_URL", "AWS_REGION", "AWS_CA_BUNDLE"}
    for raw in path.read_text(errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        if k not in wanted or os.environ.get(k):
            continue
        v = v.split("#", 1)[0].strip() if not v.strip().startswith(("'", '"')) else v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        if v:
            os.environ[k] = v


def ensure_credentials() -> None:
    if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
        return
    if not sys.stdin.isatty():
        sys.exit("no AWS credentials in the environment or .env, and stdin is not a "
                 "terminal so I cannot prompt. Export AWS_ACCESS_KEY_ID and "
                 "AWS_SECRET_ACCESS_KEY and re-run.")
    import getpass
    print("No AWS credentials found in the environment or .env.")
    os.environ["AWS_ACCESS_KEY_ID"] = input("  AWS_ACCESS_KEY_ID: ").strip()
    os.environ["AWS_SECRET_ACCESS_KEY"] = getpass.getpass("  AWS_SECRET_ACCESS_KEY (hidden): ").strip()


def make_client(args, fast_fail: bool = False):
    """fast_fail: few retries + short timeouts, for the initial reachability
    probe. A typo'd endpoint should fail in seconds, not after ten retries."""
    import boto3
    from botocore.config import Config

    if args.no_verify_ssl:
        verify = False
    elif args.ca_bundle or os.environ.get("AWS_CA_BUNDLE"):
        verify = args.ca_bundle or os.environ["AWS_CA_BUNDLE"]
    else:
        verify = True

    cfg_kwargs = dict(
        # boto3 picks path-style automatically for a custom endpoint; being
        # explicit costs nothing and removes the doubt.
        s3={"addressing_style": "path"},
        retries={"max_attempts": 2 if fast_fail else 10, "mode": "standard"},
        connect_timeout=6 if fast_fail else 15,
        read_timeout=20 if fast_fail else 120,
    )
    # botocore >= 1.36 defaults request_checksum_calculation to "when_supported",
    # which sends the body as aws-chunked with a CRC32 trailer. Real AWS accepts
    # it; many S3-compatible gateways do not, and reject the PUT with
    #     InvalidRequest: Missing checksum in trailer data
    # "when_required" makes it a plain PutObject with Content-Length, which every
    # implementation understands. Integrity is still covered: TLS on the wire,
    # and this script re-lists the bucket afterwards to compare sizes.
    # The two kwargs only exist on botocore >= 1.36, hence the fallback.
    try:
        config = Config(request_checksum_calculation="when_required",
                        response_checksum_validation="when_required", **cfg_kwargs)
    except TypeError:
        config = Config(**cfg_kwargs)

    return boto3.client(
        "s3",
        endpoint_url=args.endpoint_url,
        region_name=args.region,
        verify=verify,
        config=config,
    )


def collect(root: Path):
    """(key, path, size) for every real file under root, dotfiles excluded."""
    out = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.is_symlink():
            continue
        rel = p.relative_to(root)
        if any(part.startswith(".") for part in rel.parts):
            continue
        out.append((rel.as_posix(), p, p.stat().st_size))
    return out


def remote_sizes(client, bucket: str, prefix: str):
    """{key: size} for everything already in the bucket under prefix."""
    sizes = {}
    token = None
    while True:
        kw = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        resp = client.list_objects_v2(**kw)
        for item in resp.get("Contents", []):
            sizes[item["Key"]] = item["Size"]
        if not resp.get("IsTruncated"):
            return sizes
        token = resp.get("NextContinuationToken")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=DEFAULT_ROOT,
                    help=f"local bucket directory (default: {DEFAULT_ROOT})")
    ap.add_argument("--bucket", default=DEFAULT_BUCKET)
    ap.add_argument("--endpoint-url", default=os.environ.get("S3_ENDPOINT_URL") or DEFAULT_ENDPOINT)
    ap.add_argument("--region", default=os.environ.get("AWS_REGION") or DEFAULT_REGION)
    ap.add_argument("--prefix", default="", help="optional key prefix to add")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true", help="list what would happen, upload nothing")
    ap.add_argument("--overwrite", action="store_true",
                    help="re-upload even when a same-sized object already exists")
    ap.add_argument("--verify-only", action="store_true", help="compare local vs remote and exit")
    ap.add_argument("--env-file", default=".env")
    ap.add_argument("--ca-bundle", help="PEM path for a private CA (or set AWS_CA_BUNDLE)")
    ap.add_argument("--no-verify-ssl", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        return int(bool(sys.stderr.write(f"not a directory: {root}\n"))) or 2

    # Same reason as the Config flags in make_client(): keep botocore off
    # aws-chunked trailer checksums, which this S3 gateway rejects.
    os.environ.setdefault("AWS_REQUEST_CHECKSUM_CALCULATION", "when_required")
    os.environ.setdefault("AWS_RESPONSE_CHECKSUM_VALIDATION", "when_required")

    load_env_file(Path(args.env_file))
    if not args.dry_run:
        ensure_credentials()

    prefix = args.prefix.strip("/")
    if prefix:
        prefix += "/"

    files = collect(root)
    total_bytes = sum(s for _, _, s in files)
    print(f"local  : {root}")
    print(f"target : s3://{args.bucket}/{prefix}  via {args.endpoint_url}")
    print(f"found  : {len(files)} file(s), {human(total_bytes)}\n")
    if not files:
        return 0

    if args.dry_run and not (os.environ.get("AWS_ACCESS_KEY_ID")):
        for key, _, size in files[:20]:
            print(f"  would PUT  {prefix}{key}  ({human(size)})")
        if len(files) > 20:
            print(f"  ... and {len(files) - 20} more")
        print("\n(dry run, no credentials loaded — nothing contacted)")
        return 0

    try:
        existing = remote_sizes(make_client(args, fast_fail=True), args.bucket, prefix)
    except Exception as e:
        print(f"could not list s3://{args.bucket}/{prefix}: {type(e).__name__}: {e}")
        print("check the endpoint, credentials, and that the bucket exists.")
        return 1
    client = make_client(args)
    print(f"remote : {len(existing)} object(s) already under that prefix\n")

    todo, skipped = [], 0
    for key, path, size in files:
        full = prefix + key
        if not args.overwrite and existing.get(full) == size:
            skipped += 1
            continue
        todo.append((full, path, size))

    if args.verify_only:
        missing = [k for k, _, _ in todo]
        print(f"identical : {skipped}")
        print(f"missing or different : {len(missing)}")
        for k in missing[:40]:
            print(f"  {k}")
        if len(missing) > 40:
            print(f"  ... and {len(missing) - 40} more")
        extra = set(existing) - {prefix + k for k, _, _ in files}
        if extra:
            print(f"\nin S3 but not local : {len(extra)} (fine if the bucket is shared)")
        return 0 if not missing else 1

    print(f"skipping {skipped} identical object(s); uploading {len(todo)}\n")
    if args.dry_run:
        for full, _, size in todo[:40]:
            print(f"  would PUT  {full}  ({human(size)})")
        if len(todo) > 40:
            print(f"  ... and {len(todo) - 40} more")
        return 0
    if not todo:
        print("nothing to do — everything is already in S3.")
        return 0

    from boto3.s3.transfer import TransferConfig
    # 64MB threshold: session audio is far smaller, so almost everything goes as
    # a single PUT. Avoids multipart edge cases on S3-compatible gateways while
    # still handling a genuinely large file correctly.
    tcfg = TransferConfig(multipart_threshold=64 * 1024 * 1024,
                          multipart_chunksize=16 * 1024 * 1024,
                          max_concurrency=4, use_threads=True)

    done = failed = 0
    done_bytes = 0
    counter_lock = threading.Lock()

    def upload(item):
        full, path, size = item
        ct = CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
        client.upload_file(str(path), args.bucket, full,
                           ExtraArgs={"ContentType": ct}, Config=tcfg)
        return full, size

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(upload, it): it for it in todo}
        for fut in as_completed(futures):
            full, _, size = futures[fut]
            try:
                fut.result()
                with counter_lock:
                    done += 1
                    done_bytes += size
                    n = done
                if n % 25 == 0 or n == len(todo):
                    log(f"  {n}/{len(todo)}  ({human(done_bytes)})")
            except Exception as e:
                failed += 1
                log(f"  FAILED {full}: {type(e).__name__}: {e}")

    print(f"\nuploaded {done}, skipped {skipped}, failed {failed}")
    if failed:
        print("re-run to retry only the failures (identical objects are skipped).")
        return 1

    after = remote_sizes(client, args.bucket, prefix)
    want = {prefix + k: s for k, _, s in files}
    bad = [k for k, s in want.items() if after.get(k) != s]
    if bad:
        print(f"VERIFY FAILED: {len(bad)} object(s) missing or wrong size, e.g. {bad[:3]}")
        return 1
    print(f"verified: all {len(want)} object(s) present in S3 with matching sizes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

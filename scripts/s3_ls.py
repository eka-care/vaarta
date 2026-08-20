#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["boto3"]
# ///
"""Browse the vaarta blob store from inside a container — the `aws s3 ls/cp`
stand-in for debugging.

Works against BOTH storage backends, because it goes through the same key
scheme the app uses: local is {STORAGE_ROOT}/{bucket}/{key}, S3 is
s3://{bucket}/{key}, and only the bucket segment ever differs.

Sessions live under {date}/{session_id}/, so a session id alone is enough —
the script finds its date folder for you.

    # everything for one session (date folder found automatically)
    uv run scripts/s3_ls.py sc-8ed629372fb94fe48ddaa779e892

    # everything recorded on one day
    uv run scripts/s3_ls.py 260819

    # any raw key prefix
    uv run scripts/s3_ls.py 260819/sc-8ed6/documents/

    # show what a small text/json object actually contains
    uv run scripts/s3_ls.py sc-8ed629372fb94fe48ddaa779e892 --cat

    # pull the whole session down to ./s3dump/<session>/
    uv run scripts/s3_ls.py sc-8ed629372fb94fe48ddaa779e892 --download ./s3dump

    # inside the pod (no uv there, boto3 already installed):
    /app/.venv/bin/python scripts/s3_ls.py sc-8ed6... --cat

Credentials come from the environment or .env, same as the upload script.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

DEFAULT_ENDPOINT = "https://cdacchndstvals3arc.ipstorage.tatacommunications.com"
DEFAULT_BUCKET = "cdacchndstvals3arc-b1"
DEFAULT_REGION = "ap-south-1"

# Objects small enough and textual enough to be worth printing with --cat.
TEXTUAL = (".json", ".txt", ".md", ".log", ".csv", ".xml", ".yaml", ".yml")
CAT_MAX = 200_000

# The layout the pipeline writes, so `ls` output reads as structure not noise.
ROLE = {
    "logs/transcript.json": "stitched transcript",
    "output.json": "structuring output",
    "system_details.json": "client system info",
}


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024.0
    return f"{n}B"


def load_env_file(path: Path) -> None:
    """Fill in AWS_* / S3_* from .env without clobbering the real environment."""
    if not path.is_file():
        return
    wanted = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
              "S3_ENDPOINT_URL", "AWS_REGION", "AWS_CA_BUNDLE",
              "S3_VADED_BUCKET_NAME"}
    for raw in path.read_text(errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        if k not in wanted or os.environ.get(k):
            continue
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        else:
            v = v.split("#", 1)[0].strip()
        if v:
            os.environ[k] = v


def make_client(args):
    import boto3
    from botocore.config import Config

    if args.no_verify_ssl:
        verify = False
    else:
        verify = args.ca_bundle or os.environ.get("AWS_CA_BUNDLE") or True

    kw = dict(
        s3={"addressing_style": "path"},
        retries={"max_attempts": 3, "mode": "standard"},
        connect_timeout=10,
        read_timeout=60,
    )
    # Same reason as the upload script: botocore >= 1.36 defaults to
    # aws-chunked trailer checksums, which this gateway rejects with
    # "InvalidRequest: Missing checksum in trailer data".
    try:
        config = Config(request_checksum_calculation="when_required",
                        response_checksum_validation="when_required", **kw)
    except TypeError:
        config = Config(**kw)

    return boto3.client("s3", endpoint_url=args.endpoint_url,
                        region_name=args.region, verify=verify, config=config)


def iter_objects(client, bucket, prefix, limit=None):
    token = None
    seen = 0
    while True:
        kw = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        resp = client.list_objects_v2(**kw)
        for item in resp.get("Contents", []):
            if item["Key"].endswith("/"):
                continue
            yield item
            seen += 1
            if limit and seen >= limit:
                return
        if not resp.get("IsTruncated"):
            return
        token = resp.get("NextContinuationToken")


def find_session_prefix(client, bucket, session_id):
    """Sessions are stored as {date}/{session_id}/. Given only the id (or a
    unique fragment of it), walk the date folders to find it."""
    dates = []
    resp = client.list_objects_v2(Bucket=bucket, Delimiter="/")
    for cp in resp.get("CommonPrefixes", []):
        dates.append(cp["Prefix"])
    while resp.get("IsTruncated"):
        resp = client.list_objects_v2(Bucket=bucket, Delimiter="/",
                                      ContinuationToken=resp["NextContinuationToken"])
        for cp in resp.get("CommonPrefixes", []):
            dates.append(cp["Prefix"])

    hits = []
    for d in sorted(dates, reverse=True):  # newest date folders first
        r = client.list_objects_v2(Bucket=bucket, Prefix=d, Delimiter="/")
        for cp in r.get("CommonPrefixes", []):
            if session_id in cp["Prefix"]:
                hits.append(cp["Prefix"])
    return hits, dates


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", nargs="?", default="",
                    help="session id, date folder (YYMMDD), or a raw key prefix. "
                         "Omit to list the top-level date folders.")
    ap.add_argument("--bucket", default=os.environ.get("S3_VADED_BUCKET_NAME") or DEFAULT_BUCKET)
    ap.add_argument("--endpoint-url", default=os.environ.get("S3_ENDPOINT_URL") or DEFAULT_ENDPOINT)
    ap.add_argument("--region", default=os.environ.get("AWS_REGION") or DEFAULT_REGION)
    ap.add_argument("--cat", action="store_true",
                    help="print the contents of small text/json objects")
    ap.add_argument("--download", metavar="DIR",
                    help="download everything under the prefix into DIR")
    ap.add_argument("--limit", type=int, help="stop after N objects")
    ap.add_argument("--long", action="store_true", help="show last-modified and etag")
    ap.add_argument("--env-file", default=".env")
    ap.add_argument("--ca-bundle")
    ap.add_argument("--no-verify-ssl", action="store_true")
    args = ap.parse_args()

    os.environ.setdefault("AWS_REQUEST_CHECKSUM_CALCULATION", "when_required")
    os.environ.setdefault("AWS_RESPONSE_CHECKSUM_VALIDATION", "when_required")
    load_env_file(Path(args.env_file))

    if not (os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY")):
        if not sys.stdin.isatty():
            return int(bool(sys.stderr.write(
                "no AWS credentials in the environment or .env, and stdin is not a "
                "terminal so I cannot prompt.\n"))) or 2
        import getpass
        os.environ["AWS_ACCESS_KEY_ID"] = input("  AWS_ACCESS_KEY_ID: ").strip()
        os.environ["AWS_SECRET_ACCESS_KEY"] = getpass.getpass("  AWS_SECRET_ACCESS_KEY (hidden): ").strip()

    client = make_client(args)
    target = args.target.strip().strip("/")

    # --- no target: show the date folders -----------------------------------
    if not target:
        try:
            _, dates = find_session_prefix(client, args.bucket, "\x00")
        except Exception as e:
            print(f"cannot reach s3://{args.bucket}: {type(e).__name__}: {e}")
            return 1
        print(f"s3://{args.bucket}/  — {len(dates)} date folder(s)\n")
        for d in sorted(dates, reverse=True):
            print(f"  {d}")
        print("\npass one of these, or a session id, to list inside it.")
        return 0

    # --- resolve the prefix --------------------------------------------------
    prefix = target + "/"
    if target.startswith("sc-") and "/" not in target:
        try:
            hits, _ = find_session_prefix(client, args.bucket, target)
        except Exception as e:
            print(f"cannot reach s3://{args.bucket}: {type(e).__name__}: {e}")
            return 1
        if not hits:
            print(f"no session folder matching '{target}' in s3://{args.bucket}")
            print("try a date folder instead, or run with no argument to list dates.")
            return 1
        if len(hits) > 1:
            print(f"'{target}' matches {len(hits)} folders:")
            for h in hits:
                print(f"  {h}")
            print("\nre-run with the full prefix.")
            return 1
        prefix = hits[0]
        print(f"resolved '{target}' -> {prefix}\n")

    # --- list ----------------------------------------------------------------
    try:
        objects = list(iter_objects(client, args.bucket, prefix, args.limit))
    except Exception as e:
        print(f"list failed for s3://{args.bucket}/{prefix}: {type(e).__name__}: {e}")
        return 1

    if not objects:
        print(f"nothing under s3://{args.bucket}/{prefix}")
        return 1

    total = sum(o["Size"] for o in objects)
    print(f"s3://{args.bucket}/{prefix}  — {len(objects)} object(s), {human(total)}\n")

    width = max(len(o["Key"]) - len(prefix) for o in objects) + 2
    for o in sorted(objects, key=lambda x: x["Key"]):
        rel = o["Key"][len(prefix):]
        note = ROLE.get(rel, "")
        if o["Size"] == 0:
            note = (note + "  <-- EMPTY").strip()
        line = f"  {rel:<{width}} {human(o['Size']):>8}"
        if args.long:
            line += f"  {o['LastModified']:%Y-%m-%d %H:%M}  {o.get('ETag','').strip(chr(34))[:12]}"
        if note:
            line += f"   {note}"
        print(line)

    # --- cat -----------------------------------------------------------------
    if args.cat:
        for o in sorted(objects, key=lambda x: x["Key"]):
            rel = o["Key"][len(prefix):]
            if not rel.lower().endswith(TEXTUAL):
                continue
            print(f"\n{'=' * 70}\n{rel}  ({human(o['Size'])})\n{'=' * 70}")
            if o["Size"] == 0:
                print("(empty object)")
                continue
            if o["Size"] > CAT_MAX:
                print(f"(skipped — larger than {human(CAT_MAX)}; use --download)")
                continue
            try:
                body = client.get_object(Bucket=args.bucket, Key=o["Key"])["Body"].read()
                text = body.decode("utf-8", errors="replace")
                if rel.lower().endswith(".json"):
                    try:
                        text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
                    except Exception:
                        pass
                print(text)
            except Exception as e:
                print(f"(read failed: {type(e).__name__}: {e})")

    # --- download -------------------------------------------------------------
    if args.download:
        dest = Path(args.download).resolve()
        got = failed = 0
        for o in sorted(objects, key=lambda x: x["Key"]):
            rel = o["Key"][len(prefix):]
            out = dest / prefix.rstrip("/").split("/")[-1] / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            try:
                client.download_file(args.bucket, o["Key"], str(out))
                got += 1
            except Exception as e:
                failed += 1
                print(f"  FAILED {rel}: {type(e).__name__}: {e}")
        print(f"\ndownloaded {got} object(s) to {dest}" + (f", {failed} failed" if failed else ""))
        return 1 if failed else 0

    return 0


if __name__ == "__main__":
    sys.exit(main())

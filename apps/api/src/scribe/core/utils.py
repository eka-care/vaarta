import re
from urllib.parse import urlparse

def convert_to_s3_protocol(url):
    """
    Convert HTTPS S3 URL to S3 protocol format, or return unchanged if already S3 protocol
    
    Args:
        url (str): S3 URL (either https:// or s3:// format)
        
    Returns:
        str: S3 protocol URL (s3://bucket/path) or original URL if not HTTPS S3
        
    Examples:
        >>> convert_to_s3_protocol("https://my-bucket.s3.amazonaws.com/path/file.txt")
        "s3://my-bucket/path/file.txt"
        
        >>> convert_to_s3_protocol("s3://my-bucket/path/file.txt")
        "s3://my-bucket/path/file.txt"
        
        >>> convert_to_s3_protocol("https://example.com/file.txt")
        "https://example.com/file.txt"
    """
    if not url or not isinstance(url, str):
        return url
    
    url = url.strip()
    
    # If already S3 protocol, return as-is
    if url.startswith('s3://'):
        return url
    
    # If not HTTPS, return as-is
    if not url.startswith('https://'):
        return url
    
    try:
        # Parse the HTTPS URL
        parsed = urlparse(url)
        hostname = parsed.hostname
        
        if not hostname or not hostname.endswith('.amazonaws.com'):
            # Not an S3 URL, return as-is
            return url
        
        # Check if it's a valid S3 hostname pattern
        s3_patterns = [
            r'^([a-z0-9.\-]+)\.s3\.amazonaws\.com$',  # bucket.s3.amazonaws.com
            r'^([a-z0-9.\-]+)\.s3\.[a-z0-9\-]+\.amazonaws\.com$',  # bucket.s3.region.amazonaws.com
        ]
        
        bucket_name = None
        
        for pattern in s3_patterns:
            match = re.match(pattern, hostname, re.IGNORECASE)
            if match:
                bucket_name = match.group(1)
                break
        
        # Handle path-style URLs (s3.amazonaws.com/bucket/path or s3.region.amazonaws.com/bucket/path)
        if not bucket_name:
            path_style_patterns = [
                r'^s3\.amazonaws\.com$',  # s3.amazonaws.com
                r'^s3\.[a-z0-9\-]+\.amazonaws\.com$'  # s3.region.amazonaws.com
            ]
            
            for pattern in path_style_patterns:
                if re.match(pattern, hostname, re.IGNORECASE):
                    # Extract bucket from path
                    path_parts = parsed.path.strip('/').split('/', 1)
                    if path_parts and path_parts[0]:
                        bucket_name = path_parts[0]
                        # Update path to remove bucket name
                        if len(path_parts) > 1:
                            path = path_parts[1]
                        else:
                            path = ''
                        break
        
        if bucket_name:
            # Get the path (remove leading slash)
            if 'path' not in locals():
                path = parsed.path.lstrip('/')
            
            # Construct S3 protocol URL
            if path:
                return f"s3://{bucket_name}/{path}"
            else:
                return f"s3://{bucket_name}/"
        
        # If we couldn't parse as S3 URL, return original
        return url
        
    except Exception:
        # If any error occurs, return original URL
        return url

def batch_convert_to_s3_protocol(urls):
    """
    Convert multiple URLs to S3 protocol format
    
    Args:
        urls (list): List of URLs to convert
        
    Returns:
        list: List of converted URLs
    """
    if not isinstance(urls, list):
        return urls
    
    return [convert_to_s3_protocol(url) for url in urls]


if __name__ == "__main__":
    # Example usage
    https_url = "https://my-bucket.s3.amazonaws.com/workspace/session/20250623_120134/"
    s3_url = "s3://my-bucket/path/file.txt"
    regular_url = "https://example.com/file.txt"
    
    print("Example Usage:")
    print(f"HTTPS S3: {convert_to_s3_protocol(https_url)}")
    print(f"S3 Protocol: {convert_to_s3_protocol(s3_url)}")
    print(f"Regular URL: {convert_to_s3_protocol(regular_url)}")
    print()


def parse_additional_data(value):
    """Normalise a transaction row's additional_data to a dict.

    The current create-session flow stores it as a real JSON object; legacy
    (eka-era) rows store it as a JSON-encoded STRING. Feeding the dict form to
    orjson.loads raises "Input must be bytes, bytearray, memoryview, or str"
    and 500s every status poll on a current-flow session -- accept both shapes
    and degrade anything unparseable to {} instead of an exception.
    """
    if isinstance(value, dict):
        return value
    if isinstance(value, (bytes, bytearray, memoryview, str)):
        try:
            import orjson

            parsed = orjson.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}

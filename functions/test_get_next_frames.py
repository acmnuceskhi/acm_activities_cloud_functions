"""
Test helper for the getNextFrames Cloud Function.

Usage examples:

# install dependency
pip install requests

# call deployed function (GET)
python test_get_next_frames.py --url "https://REGION-PROJECT.cloudfunctions.net/getNextFrames" --code ABC123

# call emulator or local URL (POST)
python test_get_next_frames.py --url "http://localhost:5001/my-project/us-central1/getNextFrames" --code ABC123 --method POST

The script will print the raw JSON and a friendly summary of frames and selected questions.
"""

import argparse
import json
import sys

try:
    import requests
except Exception:
    requests = None


def call_function(url, code, method='GET', timeout=10):
    payload = {'code': code}
    headers = {'Content-Type': 'application/json'}

    if method.upper() == 'GET':
        # attach as query param
        separator = '&' if '?' in url else '?'
        full = f"{url}{separator}code={requests.utils.requote_uri(str(code))}" if requests else f"{url}?code={code}"
        if requests:
            r = requests.get(full, timeout=timeout)
            return r.status_code, r.text
        else:
            # fallback to urllib
            from urllib import request, parse
            full = f"{url}?{parse.urlencode({'code': code})}"
            with request.urlopen(full, timeout=timeout) as resp:
                return resp.getcode(), resp.read().decode('utf-8')

    else:
        if requests:
            r = requests.post(url, json=payload, headers=headers, timeout=timeout)
            return r.status_code, r.text
        else:
            import urllib.request
            import urllib.parse
            data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(url, data=data, headers=headers, method='POST')
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.getcode(), resp.read().decode('utf-8')


def pretty_print_response(text):
    try:
        data = json.loads(text)
    except Exception:
        print('Response is not valid JSON:')
        print(text)
        return

    print('\n== Raw JSON ==')
    print(json.dumps(data, indent=2, ensure_ascii=False))

    if not isinstance(data, dict):
        return

    print('\n== Summary ==')
    print('success:', data.get('success'))
    solved = data.get('solved')
    if solved is not None:
        print('solved (from score):', solved)

    frames = data.get('frames') or []
    questions = data.get('questions') or []
    print('frames returned:', len(frames))
    for i, f in enumerate(frames):
        fi = f.get('index', f.get('order', 'N/A'))
        print(f"  [{i}] frame id={f.get('id')} index={fi}")

    print('\nquestions (one random per frame):')
    for q in questions:
        frameIndex = q.get('frameIndex')
        setId = q.get('setId')
        question = q.get('question')
        if not question:
            print(f"  frameIndex={frameIndex} setId={setId} -> NO question available")
            continue
        print(f"  frameIndex={frameIndex} setId={setId} -> id={question.get('id')} text={question.get('text')[:80]!r} imageUrl={question.get('imageUrl')}")


def main():
    parser = argparse.ArgumentParser(description='Test getNextFrames Cloud Function')
    parser.add_argument('--url', '-u', required=True, help='Full function URL (e.g. https://REGION-PROJECT.cloudfunctions.net/getNextFrames)')
    parser.add_argument('--code', '-c', required=True, help='Registration/code to look up')
    parser.add_argument('--method', '-m', choices=['GET', 'POST'], default='GET', help='HTTP method to use (default GET)')
    parser.add_argument('--timeout', type=float, default=10.0, help='Request timeout seconds')

    args = parser.parse_args()

    if args.method == 'GET' and args.url.endswith('/'):
        # remove trailing slash for GET so query attach is clean
        args.url = args.url[:-1]

    if requests is None:
        print('requests library not found: falling back to urllib. For best experience install requests: pip install requests')

    try:
        status, text = call_function(args.url, args.code, method=args.method, timeout=args.timeout)
    except Exception as e:
        print('Request failed:', e)
        sys.exit(2)

    print('HTTP status:', status)
    pretty_print_response(text)

    if status >= 400:
        sys.exit(1)


if __name__ == '__main__':
    main()

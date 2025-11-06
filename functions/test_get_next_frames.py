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


def call_function(url, id_token=None, method='GET', timeout=10):
    headers = {'Content-Type': 'application/json'}
    if id_token:
        headers['Authorization'] = f'Bearer {id_token}'

    if method.upper() == 'GET':
        if requests:
            r = requests.get(url, headers=headers, timeout=timeout)
            return r.status_code, r.text
        else:
            # fallback to urllib (no header support for token)
            from urllib import request
            req = request.Request(url, headers=headers)
            with request.urlopen(req, timeout=timeout) as resp:
                return resp.getcode(), resp.read().decode('utf-8')

    else:
        if requests:
            r = requests.post(url, headers=headers, timeout=timeout)
            return r.status_code, r.text
        else:
            import urllib.request
            data = b''
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
    parser.add_argument('--id-token', dest='id_token', help='Firebase ID token (Bearer) for authentication')
    parser.add_argument('--method', '-m', choices=['GET', 'POST'], default='GET', help='HTTP method to use (default GET)')
    parser.add_argument('--method', '-m', choices=['GET', 'POST'], default='GET', help='HTTP method to use (default GET)')
    parser.add_argument('--timeout', type=float, default=10.0, help='Request timeout seconds')

    args = parser.parse_args()

    if args.method == 'GET' and args.url.endswith('/'):
        # remove trailing slash for GET
        args.url = args.url[:-1]

    if requests is None:
        print('requests library not found: falling back to urllib. For best experience install requests: pip install requests')

    try:
        status, text = call_function(args.url, id_token=args.id_token, method=args.method, timeout=args.timeout)
    except Exception as e:
        print('Request failed:', e)
        sys.exit(2)

    print('HTTP status:', status)
    pretty_print_response(text)

    if status >= 400:
        sys.exit(1)


if __name__ == '__main__':
    main()

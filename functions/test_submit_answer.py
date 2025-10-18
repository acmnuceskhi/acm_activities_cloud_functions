#!/usr/bin/env python3
"""
Simple test helper for the submitAnswer Cloud Function.

Usage examples:

# Dry run (no network call)
python test_submit_answer.py --url "https://us-central1-coder-s-cup-minigames.cloudfunctions.net/submitAnswer" --code 27J169 --set 3 --qid q1 --answer "my answer"

# Execute the POST (this will call the deployed function and may update data)
python test_submit_answer.py --url "https://us-central1-coder-s-cup-minigames.cloudfunctions.net/submitAnswer" --code 27J169 --set 3 --qid q1 --answer "my answer" --execute

The script prefers the `requests` library if available, otherwise it falls back to urllib.
"""

from __future__ import annotations

import argparse
import json
import sys

try:
    import requests
    HAS_REQUESTS = True
except Exception:
    HAS_REQUESTS = False
    import urllib.request as _urllib_request
    import urllib.error as _urllib_error


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description='Test submitAnswer HTTP function')
    p.add_argument('--url', default='https://us-central1-coder-s-cup-minigames.cloudfunctions.net/submitAnswer',
                   help='Full function URL')
    p.add_argument('--code', required=True, help='Registration code')
    p.add_argument('--set', dest='set_id', required=True, help='Question set id')
    p.add_argument('--qid', required=True, help='Question id')
    p.add_argument('--answer', required=True, help='Answer text to submit')
    p.add_argument('--execute', action='store_true', help='Perform the HTTP POST; if omitted the script prints the prepared payload')
    return p.parse_args()


def do_post_requests(url: str, payload: dict) -> None:
    try:
        r = requests.post(url, json=payload, timeout=15)
    except Exception as e:
        print('Request failed:', e)
        return
    print('HTTP', r.status_code)
    try:
        print(json.dumps(r.json(), indent=2))
    except Exception:
        print(r.text)


def do_post_urllib(url: str, payload: dict) -> None:
    data = json.dumps(payload).encode('utf-8')
    req = _urllib_request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with _urllib_request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode('utf-8')
            print('HTTP', resp.getcode())
            try:
                print(json.dumps(json.loads(body), indent=2))
            except Exception:
                print(body)
    except _urllib_error.HTTPError as e:
        print('HTTPError', e.code)
        try:
            print(e.read().decode('utf-8'))
        except Exception:
            pass
    except Exception as e:
        print('Request failed:', e)


def main() -> None:
    args = parse_args()
    payload = {
        'code': args.code,
        'questionSetId': args.set_id,
        'questionId': args.qid,
        'answer': args.answer,
    }

    print('Prepared POST to:', args.url)
    print(json.dumps(payload, indent=2))

    if not args.execute:
        print('\nDry run: not executing HTTP call. Add --execute to perform the POST (this may change remote data).')
        return

    print('\nExecuting POST...')
    if HAS_REQUESTS:
        do_post_requests(args.url, payload)
    else:
        do_post_urllib(args.url, payload)


if __name__ == '__main__':
    main()

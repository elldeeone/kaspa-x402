# PR3 failure-mode inventory (before production edits)

Base: `7231e842d8ba69190ff11868554b9bf71d7c5082`.

1. `csf_689da0dd966372097af326a6`: a caller URL with an unsupported scheme, credentials, fragment, disallowed origin, special-use IP, DNS answer to a special-use IP, or redirect can trigger a request before authorization. An absent server destination policy can do the same. A DNS precheck followed by an unrelated fetch can be rebound.
2. `csf_199510e80943b5cda1071693`: a challenge, corrective response, paid success, or replay can omit or weaken no-store; a cache can satisfy an unpaid GET from an earlier paid 200. Client fetch can consult a cache.
3. `csf_689a4f7a8fa42f9dbe77436c`: an oversized declared or streamed grant, endless body, caller abort, malformed UTF-8, over-complex JSON, or malformed delivery can reach unbounded parsing or cryptographic use. A valid bounded delivery must still work.
4. `csf_4564c6b425bf5f62466a19b4`: an oversized single frame or fragmented message reaches JavaScript before a cap; unsolicited or cumulative messages consume memory/CPU; overflow leaves the socket open or pending requests unsettled. Node, browser, and Worker transport support must be explicit.
5. `csf_acd63ad25d9834f933474e9e`: a timed-out or parent-aborted traversal can start another page, or underlying work can retain a lease after the HTTP handler releases admission, allowing overlap. A total deadline and cancellation must govern all pages.
6. `csf_497321332bb308753976b608`: REST GET or signed POST can follow 301/302/303/307/308 to another authority; an injected fetch can return an effective URL different from the pinned origin; a valid same-origin nonredirect response must work.
7. `csf_b4008edd75e4b62fd74fba41`: remote `http:`/`ws:`, hostname aliases of loopback, credentials, fragments, unexpected schemes, and TLS downgrades can become trusted chain evidence. Secure origins and explicit literal-loopback development must work.

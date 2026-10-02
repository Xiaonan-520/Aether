# Third-Party Notices

This project incorporates or derives from the following third-party works.
Each entry lists what was used and under which license. All trademarks,
product names and code referenced below remain the property of their
respective owners.

---

## jet-hub (deepseek-harness-codearts) — MIT (adapted code)

- **Project:** deepseek-harness-codearts ("jet-hub")
- **Repository:** https://gitee.com/iJetLi/deepseek-harness-codearts
- **Copyright:** Copyright (c) 2026 Jet
- **License:** MIT (https://gitee.com/iJetLi/deepseek-harness-codearts/blob/master/LICENSE)
- **What was used:** Provider adapter material — product identity constants,
  endpoint layouts, request/response protocol shapes and signing logic for the
  cline, codearts, loomy, lobsterai, trae, raccoon and qoder adapters
  (including the Qoder encrypted-inference WASM *glue* in
  `src/providers/qoder/wasm.ts`), plus architectural guidance for the account
  pool. Parts were ported or adapted; the code was substantially restructured
  for this project's provider-adapter interface.

MIT requires that the above copyright and permission notice accompany
substantial portions of the derived code. This notice satisfies that
requirement for this distribution. The MIT license text is reproduced below
as it applies to those portions.

```
MIT License

Copyright (c) 2026 Jet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## deepseek-harness — MIT (architecture reference)

- **Project:** DeepSeek Harness ("dsh")
- **Repository:** https://github.com/deepseek-ai/deepseek-harness
- **Copyright:** Copyright (c) DeepSeek AI
- **License:** MIT
- **What was used:** Architecture reference only (plugin/adapter separation,
  account-pool semantics). **No source code from this project is included in
  this repository.**

## TriDefender/zcode-api — no license (reference only)

- **Project:** zcode-api
- **Repository:** https://github.com/TriDefender/zcode-api
- **License:** None. The repository is public but ships no license file; all
  rights remain with the author.
- **What was used:** Research/reference only — publicly observable upstream
  behavior (the Aliyun captcha challenge variants and retry semantics).
  **No source code from this project is included in this repository.** This
  project makes no claim to any authorization from its author and does not
  treat it as a dependency.

## Qoder client — proprietary (not distributed)

- **Project:** Qoder desktop client `qoder-auth-wasm.wasm`
- **License:** Proprietary; no redistribution license.
- **What was used:** Nothing is included. The binary is **not** part of this
  repository or its distributions. Operators may point the gateway at their
  own copy (`QODER_WASM_PATH` or dropping the file next to the adapter); it
  must come from a client installation they are legitimately running. This
  project provides no extraction, cracking or redistribution instructions.

---

## Runtime dependencies

Runtime dependencies (hono, @hono/node-server, jose, zod, better-sqlite3 and
their transitive dependencies) are consumed as unmodified npm packages under
their own licenses (MIT / Apache-2.0 / BSD-style; see each package). They are
not redistributed in modified form. Docker images are based on
`node:22-slim` (Docker, Apache-2.0 license as distributed by the Node.js/Docker
projects).

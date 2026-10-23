# 09. GitHub, làm việc ở công ty/ở nhà và CI/CD

## 1. Mục tiêu

Repository riêng **Private** đã tạo: [hieupt91-sketch/3t-web-marketplace](https://github.com/hieupt91-sketch/3t-web-marketplace). GitHub giữ tài liệu kinh doanh và source bán hàng theo quyền truy cập của chủ dự án; trạng thái triển khai ứng dụng được ghi trong `PROJECT_STATUS.md`.

GitHub giữ source và lịch sử thay đổi; VPS/runtime chạy API, SQL và demo. GitHub Pages chỉ phù hợp phần static được cấu hình tương ứng, không thay backend/platform database. Repository không phải nơi lưu database live, ảnh khách upload hoặc backup vận hành.

## 2. Cấu trúc repo khi triển khai code

| Thư mục | Nội dung |
|---|---|
| `apps/storefront/` | Public website + customer portal |
| `apps/admin/` | Admin 3T; có thể cùng deploy frontend nhưng tách routes/permissions |
| `apps/partner/` | CTV portal/developer center |
| `apps/api/` | API control plane |
| `apps/worker/` | Jobs/outbox/reconciliation |
| `apps/runtime-agent/` | Tác vụ node nội bộ allowlist |
| `packages/contracts/` | Schema/API types, generated clients |
| `packages/ui/` | Components/design tokens |
| `packages/i18n/` | Locale packs, validation keys |
| `packages/template-sdk/` | Manifest, adapters, runtime contract |
| `templates/` | Mẫu do 3T sở hữu hoặc references tới repo mẫu |
| `infra/` | Compose, proxy, CI deployment definitions |
| `migrations/` | Platform SQL migration versioned |
| `tests/` | Contract/integration/e2e/security fixtures |
| `docs/` | Bộ đặc tả này, ADR, runbook |
| `scripts/` | Validate/build/release trợ giúp |

Bộ tài liệu hiện tại chỉ tạo các thư mục có nội dung thật. Các thư mục ứng dụng là cấu trúc mục tiêu, chưa giả có ứng dụng chạy sẵn.

## 3. Cái gì commit, cái gì không

| Commit Git | Không commit |
|---|---|
| Source/tài liệu/schema/migration | .env, passwords, private keys, tokens |
| package lockfile/toolchain versions | node_modules, vendor/cache/build output tái tạo được |
| .env.example với placeholder | Database live, SQL dump production, uploads khách |
| Seed tổng hợp, fixture nhỏ | Backup, logs có PII, payment payload thật |
| Manifest và licenses tài nguyên | Bộ ZIP bán hàng chứa secrets hoặc public link bỏ qua quyền |
| Workflow/compose đã review | Credential admin hạ tầng |

Artifact lớn lưu private object storage hoặc private artifact registry; GitHub chỉ lưu digest/metadata. Release download công khai không được dùng để phân phối bộ cài trả phí vượt qua entitlement. Nếu dùng GitHub private repo/release làm source gốc, khách vẫn tải qua gateway/backend kiểm quyền; không cấp khách quyền vào repo toàn nền tảng.

## 4. Bắt đầu ở máy hiện tại

Sau khi repo GitHub thực sự được tạo và có commit:

```bash
git clone https://github.com/hieupt91-sketch/3t-web-marketplace.git
cd 3t-web-marketplace
git status
python3 scripts/validate_docs.py
```

Windows dùng PowerShell/Git Bash và Python đã cài; macOS dùng Terminal. Khi code được khởi tạo, dev bổ sung `.env.example`, version manager/lockfile và **lệnh dev đã kiểm thử** vào README. Không yêu cầu người dùng chạy lệnh `pnpm dev` khi repo mới chỉ có tài liệu.

Nếu chỉ có bộ ZIP và chưa có remote: giải nén, tạo repo Private trên GitHub (không sinh README trùng khi sẽ đẩy repo có sẵn), rồi thực hiện dưới đây sau khi thay đúng owner nếu cần [S7].

```bash
git init -b main
git add README.md docs contracts examples scripts PROJECT_STATUS.md DECISIONS.md .gitignore .gitattributes
git commit -m "docs: define 3T web marketplace implementation"
git remote add origin https://github.com/hieupt91-sketch/3t-web-marketplace.git
git push -u origin main
```

Nếu đã có `.git`/remote từ clone thì không chạy lại `git init`/`remote add`; dùng `git remote -v` và quy trình nhánh. Đăng nhập qua công cụ Git/GitHub chính thức; không viết token vào URL remote hay chat/tài liệu. SSH key tạo trên máy cá nhân và lưu theo hướng dẫn GitHub, không commit private key.

## 5. Đổi máy và tiếp tục

**Cuối buổi làm:** `git status`, xem diff, chạy kiểm tra liên quan, commit code + cập nhật PROJECT_STATUS, push feature branch. Commit nhỏ, mô tả hành vi; không đẩy code chưa chạy mà ghi “hoàn thành”. Không commit `.env` để “về nhà cho tiện”.

```bash
git status
git diff
git add <cac-tep-da-kiem-tra>
git commit -m "feat: add template import validation"
git push -u origin feat/template-import
```

**Về nhà lần đầu:** clone repo, đăng nhập bằng chính tài khoản, checkout branch đang làm. **Những lần sau:** bảo đảm working tree sạch rồi fetch/pull. Không dùng force/reset để xóa thay đổi chưa rõ nguồn.

```bash
git fetch origin
git switch feat/template-import
git pull --ff-only
```

Tên branch trên là ví dụ; tạo bằng `git switch -c feat/template-import` trước khi làm nếu chưa có. Nếu pull không fast-forward, xem lịch sử và hợp nhất/rebase có chủ đích; không force push main. Env dev từng máy tự tạo từ example và credential dev có scope thấp. Dữ liệu dev dùng seed tổng hợp để tái tạo, không sync database live bằng Git.

## 6. Nhánh và review

- `main`: mốc tài liệu/code đã review và pass CI; protected khi cài đặt repo cho phép.
- `feat/*`, `fix/*`, `docs/*`: công việc ngắn; PR ghi problem/result/checks và UI ID/REQ liên quan.
- Release tags immutable `vX.Y.Z`; template versions độc lập platform version.
- Không sửa nội dung đã bàn giao bằng đè ZIP cùng version. Tag → commit → artifact digest được truy vết.
- CODEOWNERS bổ sung sau khi xác định reviewer thật; không tự mời người khác hoặc gán người không được yêu cầu.

## 7. CI theo từng mốc

| Workflow | Trigger | Jobs | Credentials |
|---|---|---|---|
| docs-check | PR/push docs/contracts | Markdown links, JSON/schema fixtures, UI/REQ consistency | Read-only |
| app-check | PR source sau M1 | Install frozen lockfile, lint, typecheck, unit/contract/integration | Test-only |
| e2e-staging | Trusted main/test environment | Journey payment sandbox/import/demo/i18n/CTV | Staging scope |
| release-build | Signed/reviewed tag theo policy | Build once, SBOM/checksum, artifact store | Scoped publish |
| deploy-staging | Successful immutable artifact | Migrate compatibility + rollout + smoke | Staging deploy identity |
| deploy-production | Environment gate | Backup, migrate, rollout, verify, rollback path | Production scoped identity |
| template-preview | Trusted source webhook | Fetch pinned commit, sandbox build, preview only | Read source, no production secret |

Các workflow là yêu cầu cần code, không phải pipeline đã chạy trong bản tài liệu. Không thêm workflow giả xanh hoặc bỏ tests chỉ để có badge. Tại mốc đầu có thể chỉ enable docs-check.

## 8. An toàn CI/CD

GitHub hướng dẫn giảm quyền `GITHUB_TOKEN`, quản lý secrets và thận trọng với mã nguồn không tin cậy [S8]. Thiết kế cụ thể của dự án: PR/fork chỉ chạy job không secrets; không checkout source đối tác rồi chạy trong `pull_request_target` có quyền cao. Build template không dùng runner có production credential. Action/dependency/image pin revision được review; secrets từng environment, credential ngắn hạn khi hạ tầng hỗ trợ.

Deploy bằng artifact đã build và quét, không pull nhánh đang thay đổi vào VPS production. Hạn chế command deploy qua agent; hạ tầng có cơ chế rollback, migration có compatibility gate. Chỉ sau khi jobs thực có mới ghi status/check trong README. Các lựa chọn environment protection phụ thuộc quyền/gói GitHub hiện hữu, cần kiểm tra trước khi cấu hình; không hứa tính năng gói cụ thể trong tài liệu.

## 9. Bàn giao cho phiên code tiếp theo

PROJECT_STATUS phải ghi: phiên bản đặc tả; feature đang làm; commit/branch gần nhất; kiểm tra đã chạy; hạn chế; lệnh dev đúng; bước tiếp theo nhỏ; quyết định chưa chốt. DECISIONS ghi vì sao chọn architecture, scope adapter, policy CTV. Khi dùng AI CLI, đưa README + STATUS + docs liên quan thay vì dán cả hội thoại.

## 10. Nguồn

- [S7 — GitHub tạo repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository).
- [S8 — GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use).

Kiểm tra 23/10/2026. Cấu trúc repo, release gates và workflow trong tài liệu là đề xuất triển khai của dự án.

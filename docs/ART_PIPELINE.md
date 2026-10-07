# 低成本配图工具

`scripts/art_pipeline.py` 把「登记需求 → 生成或选图 → 压缩 → 审核 → 接入」分开处理。一张主题母图可以供多个 `data-art` 插槽共用；相同图片和编码参数只生成一份实际文件。工具不改页面、不覆盖共享的 `public/art/manifest.json`。

普通流程完全离线，不调用付费 API。`generate` 是需要本人显式运行的可选入口，只连接本机已有的 ComfyUI 和模型；不安装模型，也不代表这台电脑已经可以运行模型。通过 Codex 图片工具生成母图仍受该工具的用量规则约束，本脚本不能免费调用 Codex。

## 快速开始

需要 Python 3.10+、Pillow。当前机器已验证 Pillow 12.3.0；在项目根目录运行：

```powershell
python scripts/art_pipeline.py plan
python scripts/art_pipeline.py ingest --id learning-library --input "C:\path\to\approved-master.png"
python scripts/art_pipeline.py verify
python scripts/test_art_pipeline.py
```

`learning-library` 是示例，替换为 `scripts/art-assets.json` 中的真实 `id`。配置和来源字段应先检查再导入。源图支持静态 PNG、JPEG、WebP、AVIF；一次输入一张完整图片，不会拼接或生成新场景。

常用全局选项放在子命令之前：

```powershell
python scripts/art_pipeline.py --root "C:\path\to\luokixi" --config "C:\path\to\art-assets.json" plan
```

各命令以 JSON 返回结果。失败退出码为 `1`，不会把错误当作成功。

## 配置

配置由维护者保存为 `scripts/art-assets.json`，不写 API 密钥或私密文件路径：

```json
{
  "version": 1,
  "defaults": {
    "widths": [480, 960, 1600],
    "maxBytes": 200000,
    "quality": 82,
    "minQuality": 40
  },
  "assets": [
    {
      "id": "learning-library",
      "slots": ["today-exam", "mat-english"],
      "type": "concept",
      "alt": "书页与光线组成的知识库概念插画",
      "prompt": "A sculptural library still life, quiet daylight, cobalt accents, no text or logos.",
      "source": {"title": "Codex 生成的概念插画", "url": ""},
      "rights": "AI-generated concept illustration; not a documentary photograph.",
      "reviewer": "Codex",
      "review": "pending",
      "focal": "50% 50%"
    }
  ]
}
```

- `type` 为 `concept` 或 `photo`。真实新闻现场、教师、校园实拍使用 `photo` 和真实来源；工具拒绝用生成命令制作 `photo`。
- `slots` 是页面实际 `data-art` 名称，不能分属两张母图。多个插槽复用同一张主题图时放在同一条记录中。
- `prompt` 保留生成依据；照片可以为空。`source.title`、`rights`、`reviewer` 必填，来源 URL 不接受本机路径、账号密码或带密钥的链接。
- `review` 默认为 `pending`。看过原图及裁切后才写 `approved`。此字段是维护者的记录，工具不会自动判定图像质量或许可。
- 可逐条覆盖尺寸、质量和预算。每个响应尺寸严格不超过 **200,000 字节**，最少编码质量由 `minQuality` 控制。预算不满足会报错，要求降低尺寸或换更适合的母图，不会悄悄突破限制。
- 输出保留原始比例、不放大小图。裁切由页面的容器与 `focal` 决定，不把一张图拉伸成另一种比例。

## 增量流程与产物

`plan` 检查已有 manifest 和待合并补丁，输出每张母图的缺图状态、原始提示词、可复用插槽，以及完全相同提示词/来源的重复组。它还扫描页面中写明的 `data-art="..."` 字面量，列出没有配置的插槽；动态拼接的插槽名仍需维护者登记。

`ingest` 读取本地已生成母图或已获使用许可的照片，校正 EXIF 方向，去掉图片隐藏元数据，生成 WebP。文件名由输入 SHA-256、尺寸、压缩参数与 Pillow 版本组成的哈希确定；后续相同输入直接校验和复用，跨资产也不重复编码。图片字节、配置或编码器版本变化会生成新版本，旧文件不会擅自删除。

| 位置 | 内容 | 是否可进入公开仓库 |
| --- | --- | --- |
| `public/art/generated/art-<hash>-<width>.webp` | 经过大小限制的响应图片 | 审核后可公开 |
| `campus/.data/art-pipeline/plan.json` | 缺图与提示词清单 | 本机工作记录 |
| `campus/.data/art-pipeline/cache.json` | 内容及编码缓存 | 本机工作记录 |
| `campus/.data/art-pipeline/manifest.patch.json` | 待审核/合并的插槽补丁 | 审核后选择性合并 |
| `campus/.data/art-pipeline/jobs/` | 本机 ComfyUI 任务编号与状态 | 本机工作记录 |
| `campus/.data/art-pipeline/originals/` | 本机生成器的母图 | 本机保留，不自动公开 |

上述 `.data/` 已在项目忽略规则中。使用 `--work-dir` 时仍必须在本项目内，且不能放进 `public/`。

补丁里的每个插槽包含 `src`、`srcset`、`sizes`、`w`、`h`、`alt`、`focal`、`review`、`variants` 和 `meta`。`variants` 保留实际路径、宽高、字节数、内容哈希和编码质量；`meta` 保留用途、公开来源、权利说明、提示词、审核者和原图哈希，不复制输入图片的本机路径。

审核通过后，维护者从补丁的 `slots` 选择性合并到共享 manifest。更新 `review` 后再次 `ingest` 即可利用缓存生成新审核记录。页面读取 `review: "approved"` 的项；配套的 `art.js` 必须支持响应尺寸才会使用 `srcset`。

`verify` 会真实解码文件并检查格式、宽高、字节预算、SHA-256、主图片及 `srcset` 一致性；任一失败以非零状态退出。也能检查合并结果：

```powershell
python scripts/art_pipeline.py verify --manifest public/art/manifest.json
```

旧 manifest 若没有 `variants` / 来源字段，会被严格检查报告为未满足新契约，不会被误报为已经验收。

## 可选：使用本机 ComfyUI 真正生成图片

本人先在 ComfyUI 验证已有模型和工作流，再导出 **API 格式** JSON。适配器遵循官方 [`POST /prompt`、`GET /history/{id}`、`GET /view` 示例](https://github.com/comfyanonymous/ComfyUI/blob/master/script_examples/websockets_api_example.py)，只支持代码白名单中的经典内置文生图节点，不运行任意第三方节点。

```powershell
python scripts/art_pipeline.py generate --id learning-library --workflow "C:\path\to\txt2img-api.json" --prompt-node 6 --endpoint http://127.0.0.1:8188 --timeout 90
```

`--prompt-node` 必须指向正向 `CLIPTextEncode` 节点；工具把对应资产的 prompt 写入该节点，保留工作流的负向提示词、种子和已安装模型选择。工作流限制 32 个内置节点，必须恰好包含一个 latent、一个 sampler、一个 `SaveImage`，不允许通过多个生成分支绕过单张限制。`SaveImage` 的保存前缀固定为 `luokixi/<id>`；latent 限单张、每边不超过 2048 像素，采样不超过 60 步。完成后自动下载本次输出的第一张图到私有工作目录，再走相同的 `ingest`。

这一入口没有托管模型 API 费用，但会使用本机 GPU/CPU、电力和已有模型；模型的许可由维护者确认。没有可用 ComfyUI 服务或模型时会明确失败，不会退回付费服务或安装组件。

请求仅允许字面量 loopback IP 或 `localhost`，不使用系统代理、不跟随重定向。JSON 响应限 2 MB，图片下载限 32 MB，单次等待限 1–600 秒。模型名称不得逃出模型目录，输出路径不接受目录穿越。节点白名单限制的是本适配器提交的流程，不是对整个 ComfyUI 进程的沙箱保证。

生成任务会先写本机 journal。已收到任务编号后超时，重复相同命令只继续查询同一个任务；图已生成并导入时直接命中本机缓存，零网络请求。如果提交期间断线，无法判断服务器是否已接单，工具会停止自动提交；在 ComfyUI 查明实际任务编号后再显式恢复。恢复编号必须由本人确认属于本次自有任务；适配器只读取匹配 `SaveImage` 节点的输出，不能证明任意手填编号的作品归属：

```powershell
python scripts/art_pipeline.py generate --id learning-library --workflow "C:\path\to\txt2img-api.json" --prompt-node 6 --resume-prompt-id "已确认的任务编号"
```

编码与生成分别设独占锁，避免并行命令覆盖补丁或重复提交。正常结束和超时会释放锁；进程崩溃遗留锁时，先确认锁内记录的进程已退出，再由维护者移除该私有锁文件，不自动抢占。

## 当前验证范围

2026-10-06：18 项专项测试中 17 项通过，Windows 当前测试进程无创建 symlink 权限，1 项目录链接测试跳过。路径穿越、私密目录、字节预算、坏文件、EXIF 清除、内容变化、缓存损坏、跨资产复用、`srcset` 伪造、并发锁、重定向、远程地址、响应上限、多分支/批量限制、提交断线和超时恢复均有通过的用例。

ComfyUI 的提交—查询—下载—缓存链路由真实 loopback HTTP mock 服务验证。尚未在本机安装或执行真实生成模型，因此不能把 mock 结果称为模型出图验收；本轮网站实际图片由 Codex 图片工具另行生成和人工检查。

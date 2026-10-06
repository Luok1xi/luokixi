# 参与贡献

谢谢你愿意让 Luokixi 变得更好。最简单的方式是打开网站的**参与贡献**页面填表：它会生成格式正确的文件，并带你去 GitHub 自动创建 Pull Request。下面是手动操作时需要知道的细节。

## 三种贡献

| 想做什么 | 放在哪里 | 怎么提交 |
|---|---|---|
| 发布开源项目 | `content/projects/<英文文件名>.json` | Pull Request |
| 加入刷题名录 | `content/people/<你的 GitHub 用户名>.json` | Pull Request（只能本人提交） |
| 投稿试卷、笔记 | GitHub Issue 附件 | 选择“投稿资料”模板 |
| 改进网站本身 | 对应源码 | Pull Request |

字段说明见 [docs/DATA.md](docs/DATA.md)，校验规则写在 [`src/js/schema.js`](src/js/schema.js)。

## 本地预览

```bash
npm install
npm run validate     # 检查 content/ 下的文件
npm run data         # 联网汇总社区数据（不联网用 npm run data:offline）
npm run dev
```

## 自动校验

每个改动 `content/` 的 Pull Request 都会自动检查：

- JSON 格式和必填字段；
- 链接必须是 https，并且只接受常见平台（GitHub、Gitee、立创开源、哔哩哔哩等）；
- `content/people/` 里的文件只能由本人新增、修改或删除。

## 隐私

名录只收录本人自愿登记的账号，网站只展示这些平台上本来就公开的数据。想退出，删掉自己的文件提交 PR 即可，下一次构建后数据会消失。

## 版权

- 只分享你有权分享的内容；
- 外部项目必须写清原作者（`credit`），不能当成自己的；
- 你自己整理的笔记和资料，默认按 CC BY-SA 4.0 公开；
- 网站代码采用 MIT 许可；`campus/` 目录另有说明。

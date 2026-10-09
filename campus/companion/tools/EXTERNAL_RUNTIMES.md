# 外部读取工具

本仓库保存本项目的适配代码，不携带本机账号会话或第三方软件安装副本。

- QQ 读取适配见 `qq-reader/start.ps1` 与 `src/social-readers.mjs`。NapCat 安装包、安装目录、二维码、配置和聊天数据库均已排除；需要时由使用者按上游说明在本机配置。
- 微信历史读取目前为 `wechat-reader/read.py` 的界面读取方式；本机研究用的 replica/upstream 克隆及虚拟环境未上传。不能据此宣称已打通微信原账号完整历史。
- Crawlee 运行依赖在 `crawler/package.json` / 锁文件中声明，进入该目录执行 `npm ci` 安装。
- 代码与素材归属见根目录 `THIRD-PARTY-NOTICES.md`；上游参考代码下载缓存不属于本项目功能实现。


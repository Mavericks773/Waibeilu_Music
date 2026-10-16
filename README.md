# 同听房 · 歪北路音乐

最多五人一起听音乐的私人网页服务，使用共享密码进入一个房间。支持 Chrome 手机和桌面端、MP3 上传删除、300 MB 总容量、全员播放控制、单曲循环、随机播放和中途加入自动对齐。

当前已实现本地可运行版本，使用 `yumetohazakura.mp3` 完成上传与浏览器播放验证。尚未部署至 DigitalOcean；手机锁屏、真实跨国线路与五台实体设备的一秒同步指标仍需实测。

## 本地运行

需要 Node.js 24 或更新版本。

```sh
npm ci
```

复制 `.env.example` 为 `.env`，设置自己的 `ROOM_PASSWORD`。默认访问地址 `http://localhost:3000`。

```sh
npm run typecheck
npm run build
npm test
npm start
```

打开浏览器，输入昵称和密码，上传 MP3。所有人都能控制播放及删除音乐。界面切换不会重建音频。房间满员仍可浏览歌单；第六人无法加入收听。

开发后重新执行 `npm run build` 并重启服务。`npm test` 使用最近构建结果，因此修改源码后先构建。测试在 `test-results` 下创建临时数据库并在完成后清理，不改动正式 `data` 或源 MP3。

## 文档

- [Debian 12 部署](DEPLOYMENT.md)
- [架构与文件职责](ARCHITECTURE.md)
- [需求与设计](DESIGN.md)
- [参考前端适配](FRONTEND_MAPPING.md)
- [验证记录](VALIDATION.md)

数据库和音乐保存在 DATA_DIR。默认 HTTP + WS，不要求域名或证书。音频读取须有有效收听席位；未授权不能使用直链读取。

手机首次进入或后台恢复时，Chrome 可能要求点击“继续收听”。Media Session 已接入，但操作系统挂起页面后，网页无法保证持续同步或远程唤醒。支持目标包含 iPhone Chrome，Safari 不在适配范围。

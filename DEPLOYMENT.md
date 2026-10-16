# Debian 12 部署

使用单实例 Node.js 24 LTS、Nginx、systemd，访问地址为服务器公网 IP 的 HTTP。需要先安装 Node.js 24（`node --version` 应为 v24.x 或更新受支持版本）；Debian 12 自带的旧 Node 版本不适用。本地已在 Node.js 26.5.1 验证，Debian 12/Node 24 尚待服务器实测。

## 1. 准备文件

将项目上传至 `/opt/waibeilu-music`，排除 `node_modules`、`.npm-cache`、`test-results`、`.env`、本地 `data`、设计原型和测试 MP3。测试音乐无需随生产代码分发，可部署后通过网页上传。

安装 Nginx 并创建服务用户和数据目录：

```sh
sudo apt update
sudo apt install -y nginx ca-certificates
sudo useradd --system --home /var/lib/waibeilu-music --shell /usr/sbin/nologin waibeilu
sudo install -d -o waibeilu -g waibeilu -m 700 /var/lib/waibeilu-music
cd /opt/waibeilu-music
npm ci
npm run typecheck
npm run build
npm prune --omit=dev
```

Node 的安装来源和校验按所选官方发行方式操作。若 node 不在 `/usr/bin/node`，修改 service 中的 ExecStart 为实际绝对路径。后续重新构建前执行 `npm ci` 恢复开发依赖。

## 2. 配置房间

创建 `/etc/waibeilu-music.env`。本项目已按用户指定地址准备 `.env.production`，其中包含房间密码，已从版本管理中排除。安全传到服务器后可用 `sudo install -m 600 .env.production /etc/waibeilu-music.env` 安装。密码允许至少四个字符，不使用本地预览测试密码。

```dotenv
NODE_ENV=production
ROOM_PASSWORD=your-own-room-password
PUBLIC_ORIGIN=http://165.22.110.197
PORT=3000
HOST=127.0.0.1
DATA_DIR=/var/lib/waibeilu-music
```

```sh
sudo chmod 600 /etc/waibeilu-music.env
sudo cp deploy/waibeilu-music.service /etc/systemd/system/
sudo cp deploy/nginx.conf /etc/nginx/sites-available/waibeilu-music
sudo ln -s /etc/nginx/sites-available/waibeilu-music /etc/nginx/sites-enabled/waibeilu-music
sudo unlink /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now waibeilu-music
sudo systemctl reload nginx
```

这些步骤针对没有其他站点的新服务器；重复执行前先检查符号链接。DigitalOcean 防火墙允许 SSH 与 TCP 80；3000 端口只监听本机。PUBLIC_ORIGIN 必须和浏览器实际访问的协议、IP、端口完全一致，不带末尾斜杠，否则同源校验会拒绝登录和 WS。

HTTP 按已确认需求启用，密码和会话传输不加密。使用独立密码。无需证书和域名，不要求安装为 PWA。

## 3. 验证与维护

```sh
curl http://127.0.0.1:3000/healthz
sudo systemctl status waibeilu-music
sudo journalctl -u waibeilu-music -n 100 --no-pager
```

在网页登录，上传 MP3，至少两台 Chrome 加入，验证播放、暂停、进度、随机和单曲循环。手机实际锁屏及中国线路测试必须另做，本地自动化不能代替。

修改房间密码后重启服务，旧会话会自动失效。服务重启后保留歌单、模式和最近保存位置，恢复为暂停。

## 4. 备份与恢复

建议每日备份并将备份复制至另一台机器，至少保留七天。以下方式短暂停机，确保数据库与音频文件一致；脚本不会删除旧备份。

```sh
sudo systemctl stop waibeilu-music
sudo env DATA_DIR=/var/lib/waibeilu-music /usr/bin/node /opt/waibeilu-music/scripts/backup.mjs /var/backups/waibeilu-music
sudo systemctl start waibeilu-music
```

备份失败也应重新启动服务，并检查命令错误。自动化时用运维脚本的退出清理保证重启。日志和环境密码不包含在备份脚本中；环境配置单独安全保存。备份含会话数据库，应限制文件访问。

恢复时先停服务，将选定备份的 `music.sqlite` 和 `music/` 放入一个新的、空的数据目录，配置 DATA_DIR 指向该目录，并赋予 waibeilu 用户所有权；service 的 ReadWritePaths 也对应调整。不要把备份数据库覆盖到仍有旧 WAL/SHM 文件的运行目录。先验证健康检查、歌曲可播放、容量正确，再切回正式访问。

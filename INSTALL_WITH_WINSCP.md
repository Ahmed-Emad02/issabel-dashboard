# Issabel Analytics Dashboard with GSM Dongles Tab

This package contains the Issabel analytics dashboard plus a GSM Dongles tab.

The GSM Dongles page shows:

- Dongle ID
- State: Free, Not connected, GSM not registered, etc.
- SIM number
- Provider name
- Signal RSSI
- Model
- IMEI
- IMSI
- Manual restart button for each dongle
- Green outline when the dongle is Free
- Red outline when the dongle is not Free

## Folder structure

```text
issabel-dashboard/
├── server.js
├── package.json
├── package-lock.json, if generated after npm install
├── .env.example
├── .gitignore
├── INSTALL_WITH_WINSCP.md
└── views/
    ├── sidebar.ejs
    ├── cdr.ejs
    ├── employees.ejs
    ├── operator.ejs
    ├── dashboard.ejs
    └── dongles.ejs
```

Do not upload your real `.env` file to GitHub because it contains passwords.

---

# Installation using WinSCP

## 1. Upload the folder

1. Open WinSCP.
2. Connect to your Issabel server using root SSH.
3. Upload the full `issabel-dashboard` folder to:

```text
/opt/issabel-dashboard
```

If the folder already exists, rename the old one first:

```bash
mv /opt/issabel-dashboard /opt/issabel-dashboard-backup
```

Then upload the new folder.

---

## 2. Install Node.js and npm on Issabel/CentOS 7

SSH into the server and run:

```bash
curl -fsSL https://rpm.nodesource.com/setup_16.x | bash -
```

```bash
yum -y install nodejs
```

Check:

```bash
node -v
```

```bash
npm -v
```

---

## 3. Install project packages

```bash
cd /opt/issabel-dashboard
```

```bash
npm install
```

---

## 4. Create the `.env` file

```bash
cd /opt/issabel-dashboard
```

```bash
cp .env.example .env
```

If `.env.example` is missing, create `.env` manually:

```bash
nano .env
```

Example:

```env
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASS=admin
DB_NAME=asteriskcdrdb
AMI_PORT=5038
AMI_USER=admin
AMI_PASS=admin
```

Change `DB_PASS` and `AMI_PASS` to your real passwords.

---

## 5. Configure Asterisk AMI

Open:

```bash
nano /etc/asterisk/manager.conf
```

Add at the bottom:

```ini
[admin]
secret = admin
read = system,call,agent,originate
write = system,call,agent,originate
permit = 127.0.0.1/255.255.255.255
```

The AMI username/password must match `.env`:

```env
AMI_USER=admin
AMI_PASS=admin
```

Reload AMI:

```bash
asterisk -rx "manager reload"
```

---

## 6. Test Asterisk dongle command

Before starting the dashboard, make sure this command works:

```bash
asterisk -rx "dongle show devices"
```

If this does not work, fix `chan_dongle` first.

---

## 7. Test the dashboard manually

```bash
cd /opt/issabel-dashboard
```

```bash
node server.js
```

Open in browser:

```text
http://YOUR_SERVER_IP:3000
```

Dongles page:

```text
http://YOUR_SERVER_IP:3000/dongles?lang=en
```

Stop manual test with:

```text
Ctrl + C
```

---

## 8. Run dashboard as a service

Create service file:

```bash
nano /etc/systemd/system/issabel-dashboard.service
```

Paste:

```ini
[Unit]
Description=Issabel Analytics Dashboard
After=network.target mariadb.service asterisk.service

[Service]
WorkingDirectory=/opt/issabel-dashboard
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

Save, then run:

```bash
systemctl daemon-reload
```

```bash
systemctl enable issabel-dashboard
```

```bash
systemctl start issabel-dashboard
```

Check:

```bash
systemctl status issabel-dashboard
```

---

## 9. If port 3000 is already used

Check:

```bash
ss -tulpn | grep :3000
```

Example output:

```text
users:(("node",pid=30766,fd=21))
```

Kill the old process:

```bash
kill -9 30766
```

Restart service:

```bash
systemctl restart issabel-dashboard
```

---

## 10. Files changed for the GSM Dongles tab

The dongles feature uses these files:

```text
server.js
views/sidebar.ejs
views/dongles.ejs
```

`server.js` contains:

- `/dongles` route
- `/api/dongles` route
- `/api/dongles/:id/restart` route
- parser for `asterisk -rx "dongle show devices"`

`views/sidebar.ejs` contains the new sidebar link.

`views/dongles.ejs` contains the GSM Dongles page UI.

---

## 11. GitHub upload notes

Safe to upload:

```text
server.js
package.json
views/
.env.example
.gitignore
INSTALL_WITH_WINSCP.md
README.md
```

Do not upload:

```text
.env
node_modules/
*.bak
```


### Firewall

```bash
apt update && apt install -y ufw
ufw allow 22/tcp
ufw allow 443/tcp
ufw --force enable
```

### SSL Certificate

Install acme.sh:

```bash
apt install cron socat
curl https://get.acme.sh | sh -s email=your@email.com && source ~/.bashrc
acme.sh --set-default-ca --server letsencrypt
```

Issue certificate:

```bash
acme.sh --issue --standalone -d <DOMAIN> \
  --pre-hook  "ufw allow 80/tcp; docker stop mtproto-checker-nginx 2>/dev/null || true" \
  --post-hook "docker start mtproto-checker-nginx 2>/dev/null || true; ufw delete allow 80/tcp 2>/dev/null || true" --force --debug

acme.sh --install-cert -d <DOMAIN> \
  --key-file       ./privkey.key \
  --fullchain-file ./fullchain.pem \
  --reloadcmd      "docker exec nginx mtproto-checker-nginx -s reload 2>/dev/null || true" --force --debug
```

Auto-renewal is set up via cron automatically. Verify with `crontab -l | grep acme`.
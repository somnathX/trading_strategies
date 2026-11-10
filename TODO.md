# TODO

## Live trading bot: Oracle Cloud VM (see [BOT.md](BOT.md) §3)

The Oracle account exists. The VM isn't created yet.

**Create the instance** (Compute → Instances → Create instance):
- [ ] Region (top right): India West (Mumbai)
- [ ] Image: **Canonical Ubuntu 24.04**, not Oracle Linux. Login user is `ubuntu`
- [ ] Shape: try **VM.Standard.A1.Flex** with 1 OCPU and 6 GB. If it's out of capacity, use **VM.Standard.E2.1.Micro** (needs swap for the build). Either is Always Free
- [ ] Networking: create a new VCN, choose **"Create new public subnet"**, and turn on **"Automatically assign public IPv4 address"**
- [ ] SSH keys: paste your own public key, or generate a pair and **download the private key** (to `~/.ssh/oracle-bot.key`). Oracle shows it only once
- [ ] Storage: leave the defaults
- [ ] Review: Public IPv4 = **Yes**, Image = **Ubuntu**. The cost estimate (~$2.76) is list price and ignores Always Free; a Free Tier account isn't charged

**After it's running:**
- [ ] Make the public IP **reserved** (instance → VNIC → IPv4 addresses → edit → Reserved public IP)
- [ ] Register that IP as the static IP at web.dhan.co → DhanHQ Trading APIs
- [ ] Turn on TOTP in Dhan and put `DHAN_PIN` and `DHAN_TOTP_SECRET` in `.env` (no more daily tokens)
- [ ] Create a Telegram bot with @BotFather and get the chat id (BOT.md §1)
- [ ] Send Claude the public IP and the private key path. It will install Node, build the bot, set IST timezone and cron, and start in paper mode
- [ ] Run in paper mode for a while, then switch to `BOT_MODE=live` with `LOTS=1`

## Other
- [ ] Optional: auto-skip special sessions (Muhurat trading) in the bot. Until then, set `BOT_PAUSED=1` on Diwali

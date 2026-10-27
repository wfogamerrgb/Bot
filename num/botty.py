"""Discord counting bot: sends 0000, 0001, ... 9999, one message at a time.

Supports both official Bot applications and user tokens (self-bot compatibility mode).

Commands:
    Slash command (Bot mode):
        /count start [first] [last] [delay] [where] [user]
        /count stop [user] [all_jobs]
    Text prefix (User / self-bot or Bot mode):
        !count start [first] [last] [delay] [where]
        !count stop
"""

from __future__ import annotations

import asyncio
import os
import random
import sys
from typing import Literal, Optional, Union

import discord
from discord import app_commands
import discord.gateway
import discord.http

# ---------------------------------------------------------------------------
# Transparent User Token Compatibility Layer
# ---------------------------------------------------------------------------
import aiohttp

import base64
import json
import time

DESKTOP_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

SUPER_PROPERTIES = base64.b64encode(
    json.dumps({
        "os": "Mac OS X",
        "browser": "Discord Client",
        "release_channel": "stable",
        "client_version": "1.0.9032",
        "os_version": "21.6.0",
        "os_arch": "x64",
        "system_locale": "en-US",
        "client_build_number": 250000,
        "client_event_source": None,
    }).encode()
).decode()

# Intercept low-level session requests before sending over the wire
_orig_session_request = aiohttp.ClientSession._request


def _patched_session_request(self, method, str_or_url, **kwargs):
    headers = kwargs.get("headers")
    if headers and getattr(aiohttp.ClientSession, "_is_user_account", True):
        if "Authorization" in headers:
            auth = headers["Authorization"]
            if isinstance(auth, str) and auth.startswith("Bot "):
                headers["Authorization"] = auth[4:]
        headers["User-Agent"] = DESKTOP_USER_AGENT
        headers["X-Super-Properties"] = SUPER_PROPERTIES
        headers["Accept-Language"] = "en-US,en;q=0.9"
        headers["Sec-Ch-Ua"] = '"Not_A Brand";v="8", "Chromium";v="120"'
        headers["Sec-Ch-Ua-Mobile"] = "?0"
        headers["Sec-Ch-Ua-Platform"] = '"macOS"'
    return _orig_session_request(self, method, str_or_url, **kwargs)


aiohttp.ClientSession._request = _patched_session_request
aiohttp.ClientSession._is_user_account = True

# HTTPClient request retry and error logging interceptor
_orig_http_request = discord.http.HTTPClient.request


async def _patched_request(self, route, **kwargs):
    try:
        return await _orig_http_request(self, route, **kwargs)
    except discord.HTTPException as exc:
        if exc.status != 401:
            print(f"HTTP {exc.status} on {route.method} {route.url}: {exc.text} (code={exc.code})")
        if exc.status == 401:
            # If current mode failed with 401, toggle between User and Bot mode and retry once
            current_mode = getattr(aiohttp.ClientSession, "_is_user_account", True)
            aiohttp.ClientSession._is_user_account = not current_mode
            try:
                return await _orig_http_request(self, route, **kwargs)
            except discord.HTTPException:
                aiohttp.ClientSession._is_user_account = current_mode
                raise
        raise


discord.http.HTTPClient.request = _patched_request

# Intercept send_message to attach client nonce (required for user accounts)
_orig_send_message = discord.http.HTTPClient.send_message


def _patched_send_message(self, channel_id, *, params):
    if getattr(aiohttp.ClientSession, "_is_user_account", True):
        if hasattr(params, "payload") and isinstance(params.payload, dict) and "nonce" not in params.payload:
            # Generate snowflake nonce as official client does
            params.payload["nonce"] = str(int(time.time() * 1000 - 1420070400000) << 22)
    return _orig_send_message(self, channel_id, params=params)


discord.http.HTTPClient.send_message = _patched_send_message

# Gateway identify patch for user accounts
_orig_identify = discord.gateway.DiscordWebSocket.identify


async def _patched_identify(self) -> None:
    is_user = getattr(aiohttp.ClientSession, "_is_user_account", True)
    if is_user:
        payload = {
            "op": self.IDENTIFY,
            "d": {
                "token": self.token,
                "capabilities": 16381,
                "properties": {
                    "os": "Mac OS X",
                    "browser": "Discord Client",
                    "release_channel": "stable",
                    "client_version": "1.0.9032",
                    "os_version": "21.6.0",
                    "os_arch": "x64",
                    "system_locale": "en-US",
                    "client_build_number": 250000,
                    "client_event_source": None,
                },
                "presence": {
                    "status": "online",
                    "since": 0,
                    "activities": [],
                    "afk": False,
                },
                "compress": False,
                "client_state": {
                    "guild_versions": {},
                    "highest_last_message_id": "0",
                    "read_state_version": 0,
                    "user_guild_settings_version": -1,
                    "user_settings_version": -1,
                    "private_channels_version": "0",
                    "api_code_version": 0,
                },
            },
        }
        await self.send_as_json(payload)
        return

    await _orig_identify(self)


discord.gateway.DiscordWebSocket.identify = _patched_identify


def _load_local_env() -> None:
    """Load num/.env (gitignored) into os.environ without overriding anything."""
    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    try:
        with open(env_file, encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    except OSError:
        pass


_load_local_env()

# ---------------------------------------------------------------------------
# Account & Bot Configuration
# ---------------------------------------------------------------------------
ACCOUNTS = {
    1534691790869762149: os.environ.get("DISCORD_TOKEN_1534691790869762149", ""),    1262159132887093339: os.environ.get("DISCORD_TOKEN_1262159132887093339", ""),
}

# The active account token to run (1262159132887093339 default)
DEFAULT_ACCOUNT_ID = 1262159132887093339
ACTIVE_ACCOUNT_ID = int(os.environ.get("BOT_ACCOUNT_ID", DEFAULT_ACCOUNT_ID))
TOKEN = os.environ.get("DISCORD_TOKEN") or ACCOUNTS.get(ACTIVE_ACCOUNT_ID, ACCOUNTS[DEFAULT_ACCOUNT_ID])
GUILD_ID = os.environ.get("GUILD_ID")

DEFAULT_DELAY = float(os.environ.get("DEFAULT_DELAY", 2.0))
MIN_DELAY = 1.0
DELAY_JITTER = 0.4  # ± 400ms random variation (1.6s to 2.4s)
DEFAULT_DM_TARGET = os.environ.get("DEFAULT_DM_TARGET", "FatalMC | Chat")
# Optional explicit Bot ID override from environment variable
DEFAULT_DM_USER_ID = os.environ.get("DEFAULT_DM_USER_ID")


class CounterBot(discord.Client):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        if os.environ.get("ENABLE_MEMBERS_INTENT", "").lower() in ("1", "true", "yes"):
            intents.members = True
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)
        self.jobs: dict[str, asyncio.Task] = {}

    async def application_info(self):
        # User accounts receive 403 Forbidden for /oauth2/applications/@me
        try:
            return await super().application_info()
        except discord.Forbidden:
            class DummyApp:
                id = getattr(self.user, "id", None)
                flags = 0
                interactions_endpoint_url = None
            return DummyApp()

    async def setup_hook(self) -> None:
        # User accounts do not register slash commands via Discord Application API
        if not getattr(self.user, "bot", True) or getattr(aiohttp.ClientSession, "_is_user_account", True):
            print(f"Logged in as User account: {self.user}. Slash command sync skipped; using text commands (!count).")
            return

        if GUILD_ID:
            guild = discord.Object(id=int(GUILD_ID))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()


client = CounterBot()

count = app_commands.Group(
    name="count",
    description="Send numbers one by one",
    guild_only=True,
    default_permissions=discord.Permissions(manage_guild=True),
)
client.tree.add_command(count)


def _user_matches(u: Union[discord.User, discord.Member], target: str, exact: bool = True) -> bool:
    t = target.casefold().strip()
    names = [u.name.casefold()]
    if hasattr(u, "display_name") and u.display_name:
        names.append(u.display_name.casefold())
    if getattr(u, "nick", None):
        names.append(u.nick.casefold())
    if getattr(u, "global_name", None) and u.global_name:
        names.append(u.global_name.casefold())

    if exact:
        return t in names
    return any(t in name or name in t for name in names)


async def find_fatalmc_bot_in_dms() -> tuple[discord.DMChannel, str]:
    """Search existing DMs ONLY for the FatalMC Chat bot."""
    print("Searching existing DMs ONLY for FatalMC Chat bot...")
    keywords = ["fatalmc | chat", "fatalmc chat", "fatalmc"]

    # 1. Search cached private channels
    for ch in client.private_channels:
        if isinstance(ch, discord.DMChannel) and ch.recipient:
            names = [
                ch.recipient.name.casefold(),
                getattr(ch.recipient, "display_name", "").casefold(),
                getattr(ch.recipient, "global_name", "").casefold() if getattr(ch.recipient, "global_name", None) else "",
            ]
            for kw in keywords:
                if any(kw in n for n in names if n):
                    name = ch.recipient.display_name or ch.recipient.name
                    print(f"-> Found FatalMC Chat bot in cached DMs: {name} (Bot ID: {ch.recipient.id}, Channel ID: {ch.id})")
                    return ch, name

    # 2. Fetch all DM channels directly via GET /users/@me/channels
    try:
        dm_list = await client.http.request(discord.http.Route("GET", "/users/@me/channels"))
        for data in dm_list:
            recipients = data.get("recipients", [])
            for r in recipients:
                names = [
                    r.get("username", "").casefold(),
                    r.get("global_name", "").casefold() if r.get("global_name") else "",
                ]
                for kw in keywords:
                    if any(kw in n for n in names if n):
                        ch = client._connection.add_dm_channel(data)
                        name = r.get("global_name") or r.get("username") or "FatalMC Chat"
                        print(f"-> Found FatalMC Chat bot in fetched DMs: {name} (Bot ID: {r.get('id')}, Channel ID: {ch.id})")
                        return ch, name
    except Exception as e:
        print(f"Error querying DMs list: {e}")

    raise ValueError(
        "Could not find FatalMC Chat bot in your DMs. "
        "Please send a message to the FatalMC Chat bot on Discord so the DM conversation exists, "
        "or specify DEFAULT_DM_USER_ID='<bot_id>'."
    )


async def open_dm_for_target(
    user_or_id: Optional[Union[discord.User, discord.Member, discord.ClientUser, int]] = None
) -> tuple[discord.DMChannel, str]:
    """Open or get an existing DM channel with target. Searches DMs only by default."""
    target_id = None
    if user_or_id is not None:
        if isinstance(user_or_id, int):
            target_id = user_or_id
        elif hasattr(user_or_id, "id"):
            target_id = user_or_id.id

    if target_id is None and DEFAULT_DM_USER_ID:
        try:
            target_id = int(DEFAULT_DM_USER_ID)
        except ValueError:
            pass

    # If an explicit target ID was provided or configured, open/get it directly
    if target_id is not None:
        channel = client._connection._get_private_channel_by_user(target_id)
        if channel is None:
            data = await client.http.start_private_message(target_id)
            channel = client._connection.add_dm_channel(data)

        target_name = (
            getattr(channel.recipient, "display_name", None)
            or getattr(channel.recipient, "name", None)
            or DEFAULT_DM_TARGET
            or f"Bot {target_id}"
        )
        return channel, target_name

    # Otherwise, search DMs ONLY for the FatalMC Chat bot
    return await find_fatalmc_bot_in_dms()


async def run_count(
    context: Union[discord.Interaction, discord.Message, discord.ClientUser, discord.User],
    key: str,
    target: discord.abc.Messageable,
    target_name: str,
    is_dm: bool,
    first: int,
    last: int,
    delay: float,
) -> None:
    sent = 0
    try:
        for n in range(first, last + 1):
            await target.send(f"{n:04d}")
            sent += 1
            # 2.0s ± 400ms random variation (1.6s to 2.4s)
            actual_delay = max(MIN_DELAY, delay + random.uniform(-DELAY_JITTER, DELAY_JITTER))
            await asyncio.sleep(actual_delay)
    except discord.Forbidden:
        print(f"Forbidden while sending ({key}); stopping after {sent} messages.")
        if sent == 0 and is_dm and client.user:
            # Fallback to self-DM if messaging target is forbidden
            print(f"Cannot message {target_name}. Falling back to DMing own account...")
            try:
                self_dm = await client.user.create_dm()
                for n in range(first, last + 1):
                    await self_dm.send(f"{n:04d}")
                    sent += 1
                    await asyncio.sleep(delay)
                return
            except Exception as e:
                print(f"Error sending to self DM: {e}")
        if sent == 0:
            if is_dm:
                msg = (
                    f"I can't send DMs to {target_name}. They may have direct messages closed, "
                    "do not share a mutual server, or privacy settings are blocking DMs."
                )
            else:
                msg = "I don't have permission to send messages in this channel."
            try:
                if isinstance(context, discord.Interaction):
                    await context.followup.send(msg, ephemeral=True)
                elif hasattr(context, "channel"):
                    await context.channel.send(msg)
            except discord.HTTPException:
                pass
    except discord.HTTPException as e:
        print(f"HTTPException while sending ({key}) after {sent} messages: {e}")
        if sent == 0:
            try:
                msg = f"Failed to send messages to {target_name}: {e.text if hasattr(e, 'text') else e}"
                if isinstance(context, discord.Interaction):
                    await context.followup.send(msg, ephemeral=True)
                elif hasattr(context, "channel"):
                    await context.channel.send(msg)
            except discord.HTTPException:
                pass
    finally:
        if client.jobs.get(key) is asyncio.current_task():
            client.jobs.pop(key, None)


@count.command(name="start", description="Start counting")
@app_commands.describe(
    first="First number (default 0)",
    last="Last number (default 9999)",
    delay="Seconds between messages (default 1.5, minimum 1)",
    where="Post in this channel, or send via DM (default: channel)",
    user="Target user for DMs (defaults to 'FatalMC | Chat', or pick any custom user)",
)
async def count_start(
    interaction: discord.Interaction,
    first: app_commands.Range[int, 0, 9999] = 0,
    last: app_commands.Range[int, 0, 9999] = 9999,
    delay: app_commands.Range[float, MIN_DELAY, 60.0] = DEFAULT_DELAY,
    where: Literal["channel", "dm"] = "channel",
    user: Optional[discord.User] = None,
) -> None:
    if first > last:
        await interaction.response.send_message(
            "`first` must be less than or equal to `last`.", ephemeral=True
        )
        return

    if user is not None:
        where = "dm"

    if where == "dm":
        try:
            target, target_name = await open_dm_for_target(user)
            key = f"dm:{target.id}"
            place = f"DMs with {target_name}"
            is_dm = True
        except Exception as e:
            await interaction.response.send_message(f"Failed to open DM: {e}", ephemeral=True)
            return
    else:
        if interaction.channel is None:
            await interaction.response.send_message("I can't see this channel.", ephemeral=True)
            return
        target = interaction.channel
        key = f"ch:{interaction.channel_id}"
        target_name = getattr(interaction.channel, "name", "this channel")
        place = "this channel"
        is_dm = False

    if key in client.jobs:
        await interaction.response.send_message(
            f"Already counting for {target_name}. Use `/count stop` first.", ephemeral=True
        )
        return

    total = last - first + 1
    minutes = total * delay / 60
    await interaction.response.send_message(
        f"Counting {first:04d} to {last:04d} in {place} ({total} messages, about {minutes:.0f} min).",
        ephemeral=True,
    )
    client.jobs[key] = asyncio.create_task(
        run_count(interaction, key, target, target_name, is_dm, first, last, delay)
    )


@count.command(name="stop", description="Stop counting (channel, specified user, or default DM)")
@app_commands.describe(
    user="Specific user DM job to stop (optional)",
    all_jobs="Stop all counting jobs currently running on the bot",
)
async def count_stop(
    interaction: discord.Interaction,
    user: Optional[discord.User] = None,
    all_jobs: bool = False,
) -> None:
    stopped = 0
    if all_jobs:
        for key, task in list(client.jobs.items()):
            task.cancel()
            client.jobs.pop(key, None)
            stopped += 1
    else:
        keys_to_check = set()
        if interaction.channel_id:
            keys_to_check.add(f"ch:{interaction.channel_id}")

        if user is not None:
            keys_to_check.add(f"dm:{user.id}")
        else:
            keys_to_check.add(f"dm:{interaction.user.id}")
            if DEFAULT_DM_USER_ID:
                channel = client._connection._get_private_channel_by_user(int(DEFAULT_DM_USER_ID))
                if channel:
                    keys_to_check.add(f"dm:{channel.id}")

        for key in keys_to_check:
            task = client.jobs.pop(key, None)
            if task is not None:
                task.cancel()
                stopped += 1

    message = f"Stopped {stopped} counting job(s)." if stopped else "Nothing matching is running."
    await interaction.response.send_message(message, ephemeral=True)


# ---------------------------------------------------------------------------
# Text Command Handler (!count start / !count stop) for User / Self-bot Mode
# ---------------------------------------------------------------------------
@client.event
async def on_message(message: discord.Message) -> None:
    # Allow the account owner, DM sender, or guild managers to control it
    is_self = message.author.id == client.user.id
    is_dm = isinstance(message.channel, discord.DMChannel)
    is_manager = message.guild and getattr(message.author, "guild_permissions", None) and message.author.guild_permissions.manage_guild
    if not (is_self or is_dm or is_manager):
        return

    content = message.content.strip()
    if not content.startswith("!count"):
        return

    parts = content.split()
    cmd = parts[1].lower() if len(parts) > 1 else "help"

    if cmd == "start":
        first = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
        last = int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else 9999
        delay = float(parts[4]) if len(parts) > 4 else DEFAULT_DELAY
        # If run inside a DM, default to counting in this current DM
        where = parts[5].lower() if len(parts) > 5 else ("here" if is_dm else "dm")

        if where in ("here", "channel", "this"):
            target = message.channel
            key = f"ch:{message.channel.id}"
            target_name = (
                getattr(message.channel.recipient, "display_name", None)
                if hasattr(message.channel, "recipient") and message.channel.recipient
                else getattr(message.channel, "name", "this channel")
            )
            place = "this DM" if is_dm else "this channel"
            is_dm_dest = is_dm
        else:
            try:
                target, target_name = await open_dm_for_target()
                key = f"dm:{target.id}"
                place = f"DMs with {target_name}"
                is_dm_dest = True
            except Exception as e:
                await message.channel.send(f"Error opening DM with target ({DEFAULT_DM_USER_ID}): {e}")
                return

        if key in client.jobs:
            await message.channel.send(f"Already counting for {target_name}. Use `!count stop` first.")
            return

        total = last - first + 1
        minutes = total * delay / 60
        await message.channel.send(f"Counting {first:04d} to {last:04d} in {place} ({total} messages, about {minutes:.0f} min).")
        client.jobs[key] = asyncio.create_task(
            run_count(message, key, target, target_name, is_dm_dest, first, last, delay)
        )

    elif cmd == "stop":
        stopped = 0
        for key, task in list(client.jobs.items()):
            task.cancel()
            client.jobs.pop(key, None)
            stopped += 1
        await message.channel.send(f"Stopped {stopped} counting job(s).")


@client.event
async def on_ready() -> None:
    print(f"Logged in as {client.user} (ID: {client.user.id}, bot={getattr(client.user, 'bot', False)})")
    if os.environ.get("AUTO_START", "").lower() in ("1", "true", "yes"):
        print("AUTO_START enabled: Starting count to target automatically...")
        try:
            target, target_name = await open_dm_for_target()
            key = f"dm:{target.id}"
            total = 9999 + 1
            client.jobs[key] = asyncio.create_task(
                run_count(client.user, key, target, target_name, True, 0, 9999, DEFAULT_DELAY)
            )
            print(f"Started counting to {target_name} ({total} messages)!")
        except Exception as e:
            print(f"AUTO_START failed to open DM: {e}")


if __name__ == "__main__":
    tokens_to_try = []
    if os.environ.get("DISCORD_TOKEN"):
        tokens_to_try.append(os.environ["DISCORD_TOKEN"])
    if TOKEN not in tokens_to_try:
        tokens_to_try.append(TOKEN)
    for uid, tok in ACCOUNTS.items():
        if tok not in tokens_to_try:
            tokens_to_try.append(tok)

    success = False
    for i, tok in enumerate(tokens_to_try):
        try:
            print(f"Logging in with token candidate #{i+1}...")
            client.run(tok)
            success = True
            break
        except discord.errors.LoginFailure as exc:
            print(f"Token #{i+1} failed: {exc}")
            if i + 1 < len(tokens_to_try):
                print("Trying next available account token...")
                continue
            print("\n" + "=" * 65)
            print("ERROR: All configured tokens returned 401 Unauthorized.")
            print("This means the account tokens were reset/invalidated by Discord.")
            print("To grab a fresh token:")
            print("  1. Open Discord in your browser (https://discord.com/app).")
            print("  2. Press F12 (or Cmd+Option+I) -> Network tab.")
            print("  3. Click any chat message or channel -> find any request in Network.")
            print("  4. In Request Headers, copy the value of 'authorization'.")
            print("  5. Run: DISCORD_TOKEN='your_token' python3 botty.py")
            print("=" * 65 + "\n")
            raise

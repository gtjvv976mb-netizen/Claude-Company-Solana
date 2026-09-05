# 🤖 Meet WALL-ST-E: The Autotrader Our Servers Can’t Touch

🔑 Many hosted trading bots ask you to deposit funds or trust key material to infrastructure you do not run. That creates one enormous point of failure: somebody else’s server.

🏗️ We built the opposite.

WALL-ST-E runs on **your** host and signs with a dedicated burner wallet whose private key never leaves that machine. Claude Company publishes research calls and floor-level size ceilings, but our servers cannot start, stop or unpause the local process, sign a transaction or change its live caps.

🔒 The burner key, Jupiter API key, private RPC credentials and durable journal all stay local.

📡 The owner-only WALL-ST-E tab can display a sanitized, self-reported heartbeat, readiness state, active caps and confirmed read-only balance for the burner’s **public** address. That is an observation channel—not a control plane. The website still cannot inspect a secret or command the executor.

**We publish the research. Your machine decides whether anything gets signed.**

## 🏢 The building

Claude Company is a 50-floor Solana research firm. Its trading organization has fourteen core seats plus Regime and Review: a screener, five blind analysts, a Red Team paid to attack the thesis, Risk, a PM, Compliance and a final authorizing seat among them.

🕵️ Before paid models reason about a token, deterministic checks look for known mechanical traps: live mint or freeze authority, an exit that cannot be quoted cleanly, thin liquidity and other conditions that can make a position impossible to manage.

Those checks reduce risk. They do not guarantee a token is safe. ⚠️

When a candidate clears the full desk, Claude Company publishes an **unsigned call**: an entry reference, stop, target and plain-language thesis. A tenant floor then applies its own mandate—appetite, declared bankroll, market-cap sleeve, categories, platforms and liquidity floor—and produces a size ceiling for that floor.

🎯 **The desk has conviction. The operator owns the risk.**

## 🛣️ Two ways to trade an offered call

👆 **You approve.** Every live call offered to your floor has a Buy button. It opens Jupiter with the token and suggested amount prefilled. Connect a supported wallet, inspect the swap and approve—or walk away. If the embedded widget cannot load, the page falls back to an external market page.

🤖 **WALL-ST-E enforces.** The local poller reads the same floor feed, applies another set of gates and uses only the dedicated burner on the operator’s machine.

🚫 Browser and webhook broadcasting remain disabled. In both paths, signing stays outside Claude Company.

## 🧰 Hiring your robot

The fresh installer is built for a supported Linux systemd host. The floor number is passed on the command line, the feed credential is entered privately, and a dedicated burner is generated locally when one does not already exist. A separate macOS LaunchAgent path can supervise an already configured executor; it does not create or fund one.

The safe sequence is deliberately boring:

1. 📦 **Install.** Pin the reviewed release, bind one floor feed and protect the local wallet, credentials and state files.
2. 🧪 **Rehearse.** Start in paper mode. WALL-ST-E evaluates entries on future live calls without signing. Paper mode does not simulate or track a complete paper-trade lifecycle, and the first start intentionally skips every old feed item.
3. 🔐 **Arm.** Live mode requires an exact detached release commit, a Jupiter key, two private HTTPS RPC endpoints with different provider hostnames, a durable journal and a local terminal acknowledgement that exactly matches the burner’s public address. A reviewed raised-cap profile requires a second acknowledgement bound to that wallet and all three literal cap values. You are still responsible for ensuring the two RPC services are genuinely independent.
4. 💸 **Fund last.** Only after reviewing the paper decisions and host logs should you fund the burner with an amount you can lose.

🧱 The default live canary is limited to **0.005 SOL of input per entry**, **0.01 SOL of new deployment over a rolling 24 hours** and a **0.01 SOL rolling realized-loss entry brake**.

An operator can deliberately choose a reviewed supported profile up to **0.05 SOL per trade**, **0.5 SOL rolling deployment** and a **0.15 SOL rolling realized-loss entry brake**. Raising any default requires all three values and a versioned sentence that names the exact burner wallet and exact values; it is typed at a real local terminal and fails closed on any mismatch. The website and feed cannot perform that ceremony.

On macOS, `arm-caps` additionally requires the LaunchAgent to be stopped and disabled and the entry-pause sentinel to exist. It updates all three caps atomically, starts nothing and leaves entries paused. The operator must load the same pinned release, obtain a clean monitor result and separately decide whether to remove the pause. Linux enforces the same exact wallet-and-values acknowledgement during a raised-cap live installation.

⚠️ The reviewed maxima are ceilings, not recommendations.

## 🛡️ How he decides to sign

Every 15 seconds by default, WALL-ST-E checks for new events. A call is a candidate—not an order.

It must still pass the local gauntlet:

- 🔗 **Feed integrity:** the floor, cluster, authentication and cursor must be valid.
- ⏱️ **Freshness:** the call must be no more than 45 minutes old, and the independently monitored entry mark no more than 15 minutes old.
- 📍 **Entry discipline:** the mark must remain inside the authored zone when one exists—or a bounded fallback around the reference—and stay above the stop.
- 📐 **Local risk:** stop risk, book heat, open positions, rolling deployment and loss limits, spendable balance and the desk’s size ceiling must all permit the trade.
- 🪐 **Executable cost:** Jupiter’s forward and reverse quotes must stay inside the impact, fee, slippage and round-trip-loss rails.
- 🧾 **Transaction binding:** the built transaction must contain the exact wallet, mints, amount, custody accounts, programs, signers and expiry WALL-ST-E authorized.

✅ Only then does the local host create a signature. WALL-ST-E simulates those exact signed bytes, durably records a passing attempt, and submits it.

If the network result is ambiguous, he reconciles the **same signature** instead of silently inventing a replacement order. Two RPC views are used when proving whether an uncertain attempt is safely dead. 🔍

## 📈 How he manages a position

The server’s paper record and the local executor share one versioned price policy:

- 🛑 The authored stop is enforced from entry.
- 🟡 At **1.35×**, the stop ratchets to breakeven.
- 🟠 At **1.5×**, a 25% trailing stop arms behind the high-water mark.
- 🎯 The authored target or shared **2×** rule closes the recorded position in full.
- ⏳ An unresolved position ages out after 12 hours.

🚨 The desk can also publish an unconditional exit when a new authority appears, the round-trip exit loss rises above 12%, or liquidity falls below 60% of its call-time level. Persistent market-data darkness and a thesis that no longer re-verifies can also close the call.

WALL-ST-E processes and latches exit events before considering new entries.

⚠️ **Latched does not mean magically guaranteed.** A hard stop, custody ambiguity, RPC failure or the 50% emergency exit-impact ceiling can still prevent automatic execution and require manual action.

💰 Exit proceeds return to the burner’s custody. Moving them to another wallet is a separate manual transfer using the key you control.

## 🚦 The brakes

WALL-ST-E has two local sentinel files, and they do different jobs.

🟡 **Pause entries** blocks new buys while position monitoring, managed exits and pending-attempt reconciliation continue.

🔴 **Hard stop** blocks every new submission, including automated exits. Transactions already signed or submitted still reconcile, and open positions need manual supervision while the sentinel remains present.

🛑 Stopping the systemd service is a host-level emergency brake, but stopping a process does not close an on-chain position.

The website cannot create, remove or inspect either file. It can receive and display an owner-authenticated, sanitized heartbeat and status report, but that report contains no signer, private credential or remote-control capability.

🖥️ Verify the real mode, journal, signatures and fills on the machine running the poller and on a Solana explorer you trust.

🟢 The green **Live** indicator in the cover belongs to the research desk connection—not the autotrader. WALL-ST-E telemetry is self-reported by the operator’s machine; seeing it does not let Claude Company operate the bot. That distinction is the entire point.

## ⚠️ The honest part

Nothing in this architecture makes the calls profitable. Memecoins can gap, lose liquidity and become impossible to exit at the expected price. The desk’s public record is young and is not evidence of an edge.

📉 The trade and deployment caps bound **new exposure**. The realized-loss brake blocks future entries after recorded rolling losses reach its threshold; it does not guarantee a maximum realized loss or a successful exit. Treat every amount placed in the dedicated burner as capital that can go to zero.

What we can state precisely is narrower—and more useful:

🔐 **Claude Company never receives your executor key or custodies your trading assets. The live canary signs only on the operator’s host, under local rules and operator-acknowledged caps.**

Your keys. 🔑

Your machine. 🖥️

Your robot. 🤖

👉 **claudedotcompany.com**

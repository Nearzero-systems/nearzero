# 14. Monitoring

Monitoring collects CPU, memory, disk and uptime from servers, shows them as charts, and sends alerts when thresholds are crossed.

Today only the Nearzero host's metrics are shown (on About Nearzero), network figures are collected but never shown, and alert thresholds can only be set through the API and default to off. 1.0 closes these (P2 and P3 in [24-known-gaps.md](24-known-gaps.md)).

## 14.1 Collection

- A small monitoring service on each server, set up by server setup, private (never exposed in the firewall), and authenticated with a per-server token compared in constant time.
- Defaults: a sample every 5 seconds, kept for 2 days. (Install settings can change both for the host.)
- What is collected: CPU use, memory used and total, disk used and total for the root filesystem, uptime, system information (CPU model, cores, threads, clock; OS; kernel and architecture). Network is not collected in 1.0.

## 14.2 Where it shows

- **About Nearzero** for the host: "Track host CPU, RAM, and storage usage for this Nearzero install."
- **Server details** for every other server (new), same layout.
- Controls: data points (50, 200, 500, All) and refresh (5, 10, 20, 30 seconds; no refresh with All).
- Cards: Uptime, CPU usage, RAM usage (used / total GB), Storage usage; a "System information" block; charts "CPU history" and "RAM history".
- Error: "Error fetching metrics".
- Who: people who can see monitoring for that server (instance administrators for the host).

## 14.3 Alerts

On each server's monitoring settings (new screen; owners, admins and instance administrators for the host):
- **CPU alert above** (%) and **Memory alert above** (%), each off by default (blank), 1 to 100.
- An alert fires when the value stays above the threshold for 3 consecutive samples, then not again for 30 minutes unless it drops below and rises again.
- Alerts go to notification channels that subscribe to "Server alert" ([15-notifications.md](15-notifications.md)).
- **Send a test alert** button.

## 14.4 Nightly cleanup

The daily Docker cleanup (unused images and build cache, 23:50 server time) is part of server settings ([09](09-servers-and-ssh-keys.md) 9.4) and notifies "Docker cleanup".

**Acceptance**
- A remote server's details show live CPU and memory within 10 seconds of opening.
- With a 50% CPU threshold, a CPU stress run of 30 seconds sends exactly one alert to a subscribed channel.

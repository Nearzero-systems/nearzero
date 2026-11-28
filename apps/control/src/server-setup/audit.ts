import type { AuditView } from "@nearzero/shared";
import type { ControlServices } from "../services.ts";
import { AccessFailure, loadServerAccess, signIn } from "./connection.ts";
import { parseAudit } from "./parse.ts";
import { remoteCommand, STEP_PRELUDE } from "./scripts.ts";

/**
 * The security audit on a server's details (spec 09 9.4): the host firewall and whether it denies
 * incoming traffic by default, SSH's password, key and root sign-in, and an intrusion-ban service,
 * whether it protects SSH and starts on boot (R3-07), each with a plain recommendation. It only
 * reads: nothing on the server changes. The newest result is kept.
 */

export const AUDIT_PROBE = `${STEP_PRELUDE}
set +e
trap - ERR
echo "::ufw::begin"
# "verbose" adds the default policies: "Default: deny (incoming), allow (outgoing), …" (R3-07).
if nz_has ufw; then ufw status verbose 2>&1; fi
echo "::ufw::end"
echo "::firewalld::begin"
if nz_has firewall-cmd; then
  firewall-cmd --state 2>&1
  if firewall-cmd --state >/dev/null 2>&1; then
    zone=$(firewall-cmd --get-default-zone 2>/dev/null)
    if [ -n "$zone" ]; then
      echo "zone=$zone"
      echo "target=$(firewall-cmd --permanent --zone="$zone" --get-target 2>/dev/null)"
    fi
  fi
fi
echo "::firewalld::end"
echo "::iptables::begin"
if nz_has iptables; then iptables -S INPUT 2>/dev/null; fi
echo "::iptables::end"
echo "::sshd::begin"
sshd_bin=$(command -v sshd 2>/dev/null || true)
if [ -z "$sshd_bin" ] && [ -x /usr/sbin/sshd ]; then sshd_bin=/usr/sbin/sshd; fi
if [ -n "$sshd_bin" ]; then
  "$sshd_bin" -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|usepam) '
fi
echo "::sshd::end"
echo "::ban::begin"
# Whether a service starts on boot: yes, no, or unknown (R3-07).
nz_boot() {
  if nz_has systemctl && [ -d /run/systemd/system ]; then
    case "$(systemctl is-enabled "$1" 2>/dev/null)" in
      enabled) echo yes ;;
      disabled|masked|masked-runtime|enabled-runtime|linked|linked-runtime) echo no ;;
      *) echo unknown ;;
    esac
  elif nz_has rc-update; then
    if rc-update show 2>/dev/null | grep -Eq "^[[:space:]]*$1[[:space:]]*[|][[:space:]]*[a-z]"; then echo yes; else echo no; fi
  else
    echo unknown
  fi
}
if nz_has systemctl && [ -d /run/systemd/system ]; then echo "init=systemd"
elif nz_has rc-update; then echo "init=openrc"
else echo "init=none"; fi
for name in fail2ban sshguard crowdsec; do
  process=$name
  [ "$name" = fail2ban ] && process=fail2ban-server
  if pgrep -x "$process" >/dev/null 2>&1 || pgrep -f "/$process" >/dev/null 2>&1; then
    echo "$name=active"
    printf '%s_boot=%s\\n' "$name" "$(nz_boot "$name")"
  elif nz_has "$name" || nz_has "$name-client" || nz_has "$process"; then
    echo "$name=inactive"
  else
    echo "$name=absent"
  fi
done
# The jails fail2ban runs, so the audit can tell whether it protects SSH (R3-07).
if pgrep -x fail2ban-server >/dev/null 2>&1 || pgrep -f /fail2ban-server >/dev/null 2>&1; then
  if jails=$(fail2ban-client status 2>/dev/null); then
    printf 'fail2ban_jails=%s\\n' "$(printf '%s\\n' "$jails" | sed -n 's/.*Jail list:[[:space:]]*//p' | tr -d ' \\t')"
  else
    echo "fail2ban_jails=?"
  fi
fi
echo "::ban::end"
exit 0
`;

export async function runAudit(services: ControlServices, serverId: string): Promise<AuditView> {
  const server = await loadServerAccess(services.db, serverId);
  if (!server) throw new Error("server gone");
  let view: AuditView;
  try {
    const { session, sudo } = await signIn(services, server);
    try {
      const result = await session.exec(remoteCommand({ shell: "bash", sudo }), {
        stdin: AUDIT_PROBE,
        timeoutMs: 60_000,
      });
      view = { checkedAt: new Date().toISOString(), items: parseAudit(result.stdout), error: null };
    } finally {
      session.close();
    }
  } catch (error) {
    const message =
      error instanceof AccessFailure
        ? error.failure.message
        : `The audit couldn't run: ${(error as Error).message}`;
    view = { checkedAt: new Date().toISOString(), items: [], error: message };
  }
  await services.db
    .insertInto("server_inspection")
    .values({ server_id: serverId, audit: JSON.stringify(view), audit_at: new Date() })
    .onConflict((conflict) =>
      conflict
        .column("server_id")
        .doUpdateSet({ audit: JSON.stringify(view), audit_at: new Date() }),
    )
    .execute();
  return view;
}

export async function storedAudit(
  services: ControlServices,
  serverId: string,
): Promise<AuditView | null> {
  const row = await services.db
    .selectFrom("server_inspection")
    .select("audit")
    .where("server_id", "=", serverId)
    .executeTakeFirst();
  const value = row?.audit as AuditView | null | undefined;
  return value && Array.isArray(value.items) ? value : null;
}

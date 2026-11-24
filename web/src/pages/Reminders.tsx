// Account > Reminders: a daily Slack DM when cards are due.
import { useCallback, useEffect, useState } from 'react';
import { api, type ReminderSettings } from '../api';
import { useSession } from '../App';
import { SCard, Notice } from '../components/Settings';

export default function RemindersPage() {
  const { user } = useSession();
  const [s, setS] = useState<ReminderSettings | null>(null);
  const [memberId, setMemberId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const run = useCallback(async (fn: () => Promise<ReminderSettings | void>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); if (r) setS(r); if (ok) setMsg({ kind: 'ok', text: ok }); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { api.reminders().then(setS).catch((e) => setMsg({ kind: 'error', text: (e as Error).message })); }, []);

  if (!s) return msg ? <Notice kind="error">{msg.text}</Notice> : null;
  const sum = s.summary;

  return (
    <>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}

      {!s.slackConfigured ? (
        <SCard title="Slack" desc="Reminders arrive as a direct message from this Recall’s Slack bot.">
          <div className="s-pad">
            <Notice>Slack isn’t set up on this Recall yet. An admin creates a Slack app with the <code>chat:write</code> and <code>users:read.email</code> bot scopes, installs it, and sets <code>SLACK_BOT_TOKEN</code>.</Notice>
          </div>
        </SCard>
      ) : (
        <SCard title="Slack" desc="Reminders arrive as a direct message from this Recall’s Slack bot, so only you see them."
          action={s.slackUser && <span className="pill ok sm">Connected</span>}>
          <div className="s-pad grid">
            {s.slackUser ? (
              <div className="row wrap">
                <span className="grow text-md">Sending to <b>{s.slackUser.name}</b> <span className="faint">({s.slackUser.id})</span></span>
                <button className="btn sm" disabled={busy} onClick={() => run(async () => { const r = await api.testReminder(); setMsg({ kind: 'ok', text: r.sent ? 'Sent. Check your Slack DMs.' : 'Nothing sent.' }); })}>Send a test</button>
                <button className="btn ghost sm danger" disabled={busy} onClick={() => run(() => api.unlinkSlack())}>Disconnect</button>
              </div>
            ) : (
              <>
                <div className="row wrap">
                  <button className="btn primary" disabled={busy} onClick={() => run(() => api.linkSlack(), 'Connected.')}>Find me by email</button>
                  <span className="muted text-sm">Looks up <b>{user.email}</b> in the workspace.</span>
                </div>
                <form className="row wrap" onSubmit={(e) => { e.preventDefault(); if (memberId.trim()) run(() => api.linkSlack(memberId.trim()), 'Connected.'); }}>
                  <input className="input" style={{ maxWidth: 220 }} placeholder="U012AB3CD" value={memberId} onChange={(e) => setMemberId(e.target.value)} aria-label="Slack member ID" />
                  <button className="btn" disabled={busy || !memberId.trim()}>Use member ID</button>
                  <span className="faint text-sm">Different email in Slack? Profile → ⋮ → Copy member ID.</span>
                </form>
              </>
            )}
          </div>
        </SCard>
      )}

      <SCard title="Daily reminder" desc="One message a day at this time, only if cards are due. It mentions your streak so it’s easy to keep."
        action={
          <label className="switch">
            <input type="checkbox" checked={s.enabled} disabled={busy || !s.slackUser} onChange={(e) => run(() => api.updateReminders({ enabled: e.target.checked }))} />
            <span /> <span className="text-md">{s.enabled ? 'On' : 'Off'}</span>
          </label>
        }>
        <div className="s-pad grid">
          <div className="row wrap">
            <label className="field">Time
              <input className="input" type="time" value={s.time} disabled={busy} onChange={(e) => setS({ ...s, time: e.target.value })}
                onBlur={(e) => { if (e.target.value) run(() => api.updateReminders({ time: e.target.value })); }} />
            </label>
            <span className="muted text-sm" style={{ alignSelf: 'end', paddingBottom: 10 }}>{s.timezone ? `Your time (${s.timezone.replace(/_/g, ' ')})` : 'The server’s time'}</span>
          </div>
          <div className="faint text-sm">
            Right now: {sum.due ? `${sum.due.toLocaleString()} card${sum.due === 1 ? '' : 's'} due, about ${sum.minutes} min` : 'nothing due'}
            {sum.streak ? ` · ${sum.streak}-day streak` : ''}
            {s.lastSent ? ` · last checked ${s.lastSent}` : ''}
          </div>
          {!s.slackUser && s.slackConfigured && <div className="faint text-sm">Connect Slack above to turn this on.</div>}
        </div>
      </SCard>
    </>
  );
}

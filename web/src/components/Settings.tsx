import { NavLink, Link } from 'react-router-dom';

export type NavGroup = { label: string; items: { to: string; label: string; badge?: number | string }[] };

/** Orchard-style settings page: breadcrumb, header card, grouped section nav, content. */
export function SettingsLayout({ crumb, header, nav, children }: { crumb: string; header?: React.ReactNode; nav: NavGroup[]; children: React.ReactNode }) {
  return (
    <div className="settings">
      <nav className="crumbs"><span className="crumb"><Link to="/">Home</Link></span><span className="crumb"><span>{crumb}</span></span></nav>
      {header}
      <div className="settings-body">
        <aside className="settings-nav">
          {nav.map((g) => (
            <div key={g.label} className="sn-group">
              <div className="sn-label">{g.label}</div>
              {g.items.map((i) => (
                <NavLink key={i.to} to={i.to} end className={({ isActive }) => `sn-item ${isActive ? 'on' : ''}`}>
                  {i.label}{i.badge ? <span className="badge quiet">{i.badge}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </aside>
        <div className="settings-content">{children}</div>
      </div>
    </div>
  );
}

/** A titled card with an optional action on the right of the title. */
export function SCard({ title, desc, action, children }: { title: string; desc?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="s-card">
      <div className="s-card-head">
        <div style={{ minWidth: 0 }}>
          <h3>{title}</h3>
          {desc && <p>{desc}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One row inside a card: icon, primary + secondary text, actions on the right. */
export function SRow({ icon, title, sub, children }: { icon?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="s-row">
      {icon && <span className="s-row-icon">{icon}</span>}
      <div className="s-row-body">
        <div className="s-row-title">{title}</div>
        {sub && <div className="s-row-sub">{sub}</div>}
      </div>
      {children && <div className="s-row-end">{children}</div>}
    </div>
  );
}

export function Notice({ kind = 'info', children, onClose }: { kind?: 'info' | 'ok' | 'error'; children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className={`notice ${kind}`}>
      <span style={{ flex: 1 }}>{children}</span>
      {onClose && <button className="btn ghost sm" onClick={onClose}>Dismiss</button>}
    </div>
  );
}

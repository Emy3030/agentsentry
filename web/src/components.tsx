import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';

export type IconName =
  | 'overview'
  | 'rules'
  | 'activity'
  | 'security'
  | 'settings'
  | 'arrow'
  | 'external'
  | 'check'
  | 'lock'
  | 'shield'
  | 'clock'
  | 'alert'
  | 'plus'
  | 'close'
  | 'chevron'
  | 'wallet'
  | 'spark';

const iconPaths: Record<IconName, ReactNode> = {
  overview: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></>,
  rules: <><path d="M4 5h16M4 12h16M4 19h16" /><circle cx="8" cy="5" r="2" fill="currentColor" stroke="none" /><circle cx="16" cy="12" r="2" fill="currentColor" stroke="none" /><circle cx="10" cy="19" r="2" fill="currentColor" stroke="none" /></>,
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
  security: <><path d="M12 3 20 6v5c0 5-3.4 8.2-8 10-4.6-1.8-8-5-8-10V6l8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a7.9 7.9 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a7.9 7.9 0 0 1-1.7-1l-1.7.7-1.4-2.4 1.4-1.1a7.8 7.8 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a7.9 7.9 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a7.9 7.9 0 0 1 1.7 1l1.7-.7 1.4 2.4-1.4 1.1a7.8 7.8 0 0 1 0 2Z" transform="translate(-2 -2) scale(1.15)" /></>,
  arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  shield: <><path d="M12 3 20 6v5c0 5-3.4 8.2-8 10-4.6-1.8-8-5-8-10V6l8-3Z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  alert: <><path d="m10.3 4.3-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-2.7l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  chevron: <><path d="m9 18 6-6-6-6" /></>,
  wallet: <><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 9h18M16 15h2" /></>,
  spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" /></>,
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {iconPaths[name]}
    </svg>
  );
}

export function DemoBadge({ children = 'DEMO' }: PropsWithChildren) {
  return <span className="demo-badge"><span className="demo-dot" />{children}</span>;
}

export function Panel({ className = '', children }: PropsWithChildren<{ className?: string }>) {
  return <section className={`panel ${className}`}>{children}</section>;
}

export function SectionHeading({ eyebrow, title, detail, action }: { eyebrow?: string; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {action}
    </div>
  );
}

export function Button({ variant = 'secondary', className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger'; className?: string }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{children}</button>;
}

export function StatusBadge({ status }: { status: string }) {
  const className = status.toLowerCase().replaceAll('_', '-');
  return <span className={`status-badge status-${className}`}><span className="status-dot" />{status}</span>;
}

export function EmptyState({ icon, title, description }: { icon: IconName; title: string; description: string }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon} size={20} /></div><strong>{title}</strong><p>{description}</p></div>;
}

export function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string }>) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

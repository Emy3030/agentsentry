import { useEffect, useMemo, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import { demoDataSource } from './demoData';
import type { AuthorizationRecord, PaymentActivity, PaymentStatus, VaultReadAdapter, VaultReadResult, VaultSnapshot, VaultStateView } from './types';
import { Button, DemoBadge, EmptyState, Field, Icon, Panel, SectionHeading, StatusBadge } from './components';
import { ThreatSimulation } from './ThreatSimulation';
import { LiveRpcReadAdapter } from './services/vaultAdapter';

// Contract reads are opt-in. No account ID is assumed or bundled into the app.
const contractAccountId = import.meta.env.VITE_NEAR_CONTRACT_ACCOUNT_ID?.trim() ?? '';
const rpcEndpoint = import.meta.env.VITE_NEAR_RPC_URL?.trim() || 'https://rpc.testnet.near.org';
const vaultAdapter: VaultReadAdapter | null = contractAccountId
  ? new LiveRpcReadAdapter(rpcEndpoint, contractAccountId)
  : null;

const navItems = [
  { label: 'Overview', to: '/', icon: 'overview' as const },
  { label: 'Authorizations', to: '/authorizations', icon: 'rules' as const },
  { label: 'Transactions', to: '/transactions', icon: 'activity' as const },
  { label: 'Security Center', to: '/security', icon: 'security' as const },
  { label: 'Vault Settings', to: '/settings', icon: 'settings' as const },
];

const pageTitles: Record<string, string> = {
  '/': 'Overview',
  '/authorizations': 'Authorizations',
  '/transactions': 'Transactions',
  '/security': 'Security Center',
  '/settings': 'Vault Settings',
};

function App() {
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [authorizations, setAuthorizations] = useState<AuthorizationRecord[]>(() => demoDataSource.getAuthorizations());
  const [vaultRead, setVaultRead] = useState<VaultReadResult<VaultStateView> | { status: 'loading' }>(() => (
    vaultAdapter ? { status: 'loading' } : { status: 'unavailable', reason: 'not-configured' }
  ));
  const pageTitle = pageTitles[location.pathname] ?? 'Overview';

  useEffect(() => {
    if (!vaultAdapter) return;
    let active = true;
    void vaultAdapter.getVaultState().then((result) => {
      if (active) setVaultRead(result);
    });
    return () => { active = false; };
  }, []);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
      <div className="brand-lockup">
          <div className="brand-mark"><Icon name="shield" size={21} /><span className="brand-monogram">BP</span></div>
          <div className="brand-name">Bastion<span>Pro</span><small>PAYMENT SECURITY</small></div>
          <button className="mobile-close" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation"><Icon name="close" /></button>
        </div>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} onClick={() => setMobileNavOpen(false)} className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`}>
              <Icon name={item.icon} size={18} /><span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <div className="boundary-card">
          <div className="boundary-icon"><Icon name="lock" size={16} /></div>
          <div><strong>Contract policy model</strong><p>Enforcement requires a deployed contract call.</p></div>
          <DemoBadge>ILLUSTRATIVE</DemoBadge>
        </div>
        <div className="sidebar-footer"><span className="footer-status-dot" />Phase 1 · Demo workspace<span>v0.1</span></div>
      </aside>

      {mobileNavOpen && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><span /><span /><span /></button>
            <div className="breadcrumbs"><span>BASTIONPRO</span><Icon name="chevron" size={13} /><strong>{pageTitle.toUpperCase()}</strong></div>
          </div>
          <div className="topbar-right">
            <div className="network-state"><span className="network-dot" /><span>Wallet not connected</span></div>
            <span className="topbar-divider" />
            <DemoBadge>DEMO MODE</DemoBadge>
          </div>
        </header>

        <div className="page-content">
          <Routes>
            <Route path="/" element={<OverviewPage vaultRead={vaultRead} />} />
            <Route path="/authorizations" element={<AuthorizationsPage records={authorizations} setRecords={setAuthorizations} />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/security" element={<SecurityPage vaultRead={vaultRead} />} />
            <Route path="/settings" element={<SettingsPage vaultRead={vaultRead} />} />
            <Route path="*" element={<OverviewPage vaultRead={vaultRead} />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function DataNotice({ children = 'Illustrative demo data · not read from NEAR' }: { children?: string }) {
  return <div className="data-notice"><span className="notice-mark">i</span><span>{children}</span><DemoBadge /></div>;
}

function AdapterWarning({ state }: { state: VaultReadResult<VaultStateView> | { status: 'loading' } }) {
  if (state.status === 'unavailable' && state.reason === 'not-configured') {
    return <div className="adapter-warning" role="status">No contract account configured. Visualizing demo fixtures safely.</div>;
  }
  if (state.status === 'unavailable' && state.reason === 'rpc-error') {
    return <div className="adapter-warning" role="status">Network Offline: Visualizing Demo Fixtures Safely.</div>;
  }
  if (state.status === 'unavailable' && state.reason === 'contract-error') {
    return <div className="adapter-warning" role="status">Contract read unavailable: Visualizing Demo Fixtures Safely.</div>;
  }
  return null;
}

function toVaultSnapshot(state: VaultStateView): VaultSnapshot {
  return {
    vaultBalanceNear: yoctoToNear(state.vault_balance),
    reservedBalanceNear: yoctoToNear(state.reserved_balance),
    frozen: state.is_frozen,
    consecutiveViolations: state.consecutive_violations,
    maxConsecutiveViolations: state.max_consecutive_violations,
    persistedDenialCount: state.total_denials_logged,
  };
}

function yoctoToNear(yocto: string): string {
  const value = BigInt(yocto);
  const whole = value / 10n ** 24n;
  const fraction = (value % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function nearDecimalToYocto(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,24}))?$/.exec(value);
  if (!match) throw new Error('Invalid NEAR decimal value');
  const fraction = (match[2] ?? '').padEnd(24, '0');
  return BigInt(match[1]) * 10n ** 24n + BigInt(fraction || '0');
}

function subtractNearValues(total: string, reserved: string): string {
  const difference = nearDecimalToYocto(total) - nearDecimalToYocto(reserved);
  const sign = difference < 0n ? '-' : '';
  const absolute = difference < 0n ? -difference : difference;
  const cents = (absolute + 5n * 10n ** 21n) / 10n ** 22n;
  return `${sign}${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-intro"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function OverviewPage({ vaultRead }: { vaultRead: VaultReadResult<VaultStateView> | { status: 'loading' } }) {
  const isLive = vaultRead.status === 'available';
  const snapshot = isLive ? toVaultSnapshot(vaultRead.value) : demoDataSource.getSnapshot();
  const activity = demoDataSource.getRecentActivity();
  const available = subtractNearValues(snapshot.vaultBalanceNear, snapshot.reservedBalanceNear);

  return <>
    <PageIntro eyebrow="CONTROL PLANE / 01" title="Overview" description="A clear view of what your AI agents can request—and what the contract will allow." action={<DemoBadge>DEMO ENVIRONMENT</DemoBadge>} />
    <DataNotice>{isLive ? 'Vault state read from configured NEAR RPC · activity and authorization data remain demo fixtures' : undefined}</DataNotice>
    <AdapterWarning state={vaultRead} />

    <Panel className="hero-panel">
      <div className="hero-copy">
        <div className="hero-kicker"><span className="hero-kicker-line" />THE SECURITY BOUNDARY</div>
        <h2>AI can propose.<br /><em>The contract decides.</em></h2>
        <p>BastionPro is designed to place an independent NEAR contract between an AI agent and a vault. Contract checks apply only to payment calls made to an initialized deployment.</p>
        <NavLink to="/security" className="text-link">Explore the security controls <Icon name="arrow" size={16} /></NavLink>
      </div>
      <div className="flow-diagram" aria-label="Illustrative payment security flow">
        <FlowNode number="01" title="AI agent" detail="Proposes a payment" icon="spark" tone="muted" />
        <div className="flow-connector"><span /><span /><span /></div>
        <FlowNode number="02" title="BastionPro" detail="Checks owner rules" icon="shield" tone="accent" />
        <div className="flow-connector"><span /><span /><span /></div>
        <FlowNode number="03" title="NEAR contract" detail="Enforces the decision" icon="lock" tone="accent" />
        <div className="flow-outcomes"><div><span className="outcome-dot outcome-green" />Approved → payment can proceed</div><div><span className="outcome-dot outcome-red" />Mismatch → request is denied</div></div>
        <div className="flow-demo-note">Illustrative flow · not a live contract transaction</div>
      </div>
    </Panel>

    <ThreatSimulation />

    <div className="metrics-grid">
      <MetricCard label="Vault balance" value={`${snapshot.vaultBalanceNear} NEAR`} note={isLive ? 'Configured contract account balance' : 'Demo contract balance'} icon="wallet" tone="neutral" isLive={isLive} />
      <MetricCard label="Reserved" value={`${snapshot.reservedBalanceNear} NEAR`} note="Pending transfer reservation" icon="clock" tone="amber" isLive={isLive} />
      <MetricCard label="Available" value={`${available} NEAR`} note="Derived: balance − reserved" icon="check" tone="green" isLive={isLive} />
      <MetricCard label="Security status" value={snapshot.frozen ? 'Frozen' : 'Active'} note={isLive ? 'Read from configured NEAR RPC' : 'Illustrative contract state'} icon="shield" tone="green" isLive={isLive} />
    </div>

    <div className="overview-grid">
      <Panel className="activity-panel">
        <SectionHeading eyebrow="DEMO FEED" title="Recent activity" detail="Illustrative events, not complete on-chain history." action={<NavLink className="subtle-link" to="/transactions">View activity <Icon name="arrow" size={14} /></NavLink>} />
        <ActivityList items={activity.slice(0, 3)} />
      </Panel>
      <Panel className="denial-panel">
        <SectionHeading eyebrow="SECURITY SIGNAL" title="Denial summary" detail="Persisted denial counters · demo values" />
        <div className="denial-total"><span className="denial-total-value">{snapshot.persistedDenialCount}</span><span className="denial-total-label">recorded denials</span><DemoBadge>{isLive ? 'ON-CHAIN READ' : 'DEMO FIXTURE'}</DemoBadge></div>
        <div className="mini-bars"><div className="mini-bar-row"><span>Recipient mismatch</span><strong>07</strong><i><b style={{ width: '78%' }} /></i></div><div className="mini-bar-row"><span>Amount above limit</span><strong>03</strong><i><b style={{ width: '42%' }} /></i></div><div className="mini-bar-row"><span>Expired authorization</span><strong>02</strong><i><b style={{ width: '28%' }} /></i></div></div>
        <NavLink className="subtle-link denial-link" to="/security">Open security center <Icon name="arrow" size={14} /></NavLink>
      </Panel>
    </div>

    <div className="notice-strip"><div className="notice-shield"><Icon name="shield" size={17} /></div><p><strong>Contract enforcement is the intended boundary.</strong> This frontend has no wallet connection or signed payment calls; the simulation is illustrative.</p><span className="notice-source">OWNER CALLS NOT IMPLEMENTED</span></div>
  </>;
}

function FlowNode({ number, title, detail, icon, tone }: { number: string; title: string; detail: string; icon: 'spark' | 'shield' | 'lock'; tone: string }) {
  return <div className={`flow-node flow-node-${tone}`}><span className="flow-number">{number}</span><span className="flow-icon"><Icon name={icon} size={18} /></span><strong>{title}</strong><small>{detail}</small></div>;
}

function MetricCard({ label, value, note, icon, tone, isLive }: { label: string; value: string; note: string; icon: 'wallet' | 'clock' | 'check' | 'shield'; tone: string; isLive: boolean }) {
  return <Panel className={`metric-card metric-${tone}`}><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon name={icon} size={17} /></span></div><div className="metric-value">{value}</div><div className="metric-bottom"><span>{note}</span><DemoBadge>{isLive ? 'ON-CHAIN READ' : 'DEMO FIXTURE'}</DemoBadge></div></Panel>;
}

function ActivityList({ items }: { items: PaymentActivity[] }) {
  if (!items.length) return <EmptyState icon="activity" title="No activity to show" description="No records are available for this view." />;
  return <div className="activity-list">{items.map((item) => <div className="activity-row" key={item.id}>
    <div className={`activity-symbol activity-symbol-${item.status.toLowerCase()}`}><Icon name={item.status === 'DENIED' ? 'close' : item.status === 'PENDING' ? 'clock' : item.status === 'FAILED' ? 'alert' : 'check'} size={16} /></div>
    <div className="activity-main"><strong>{item.title}</strong><span>{item.recipient}</span></div>
    <div className="activity-amount"><strong>{item.amountNear} <small>NEAR</small></strong><StatusBadge status={item.status} /></div>
    <div className="activity-time">{item.occurredAt}<small>{item.source}</small></div>
  </div>)}</div>;
}

function AuthorizationsPage({ records, setRecords }: { records: AuthorizationRecord[]; setRecords: Dispatch<SetStateAction<AuthorizationRecord[]>> }) {
  const [revokeTarget, setRevokeTarget] = useState<AuthorizationRecord | null>(null);
  const [formError, setFormError] = useState('');
  const [formNotice, setFormNotice] = useState('');

  function createAuthorization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const initiator = String(form.get('initiator') ?? '').trim();
    const recipient = String(form.get('recipient') ?? '').trim();
    const amount = String(form.get('amount') ?? '').trim();
    const expiry = String(form.get('expiry') ?? '');
    const accountPattern = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
    if (!accountPattern.test(initiator) || !accountPattern.test(recipient)) {
      setFormError('Use valid NEAR account IDs (2–64 lowercase letters, digits, dots, hyphens, or underscores).');
      setFormNotice('');
      return;
    }
    if (!/^\d+(\.\d{1,24})?$/.test(amount) || nearDecimalToYocto(amount) <= 0n) {
      setFormError('Enter a positive amount with up to 24 decimal places.');
      setFormNotice('');
      return;
    }
    if (!expiry || new Date(`${expiry}T23:59:59`).getTime() <= Date.now()) {
      setFormError('Choose an expiry date in the future.');
      setFormNotice('');
      return;
    }
    const record: AuthorizationRecord = {
      id: `local-${Date.now().toString(36)}`,
      initiator,
      recipient,
      maxAmountNear: amount,
      expiresAt: expiry,
      status: 'ACTIVE',
      source: 'LOCAL DEMO',
    };
    setRecords((current) => [record, ...current]);
    event.currentTarget.reset();
    setFormError('');
    setFormNotice('Added to in-memory demo state. It resets on reload; no contract call was made.');
  }

  function confirmRevoke() {
    if (!revokeTarget) return;
    setRecords((current) => current.map((record) => record.id === revokeTarget.id ? { ...record, status: 'REVOKED', source: 'LOCAL DEMO' } : record));
    setFormNotice('Demo state updated in memory. It resets on reload; no revoke transaction was submitted.');
    setRevokeTarget(null);
  }

  return <>
    <PageIntro eyebrow="POLICY / 02" title="Authorizations" description="Define the exact boundaries an agent must stay within. Only the NEAR contract can enforce these rules." />
    <DataNotice>Existing rows are illustrative fixtures; new rows are held in this browser session only.</DataNotice>
    <div className="auth-layout">
      <Panel className="records-panel">
        <SectionHeading eyebrow="POLICY REGISTER" title="Payment rules" detail={`${records.length} displayed · not a complete contract enumeration`} action={<DemoBadge>LOCAL + DEMO</DemoBadge>} />
        {records.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Authorization</th><th>Approved recipient</th><th>Limit</th><th>Expires</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{records.map((record) => <tr key={record.id}>
          <td><div className="primary-cell">{record.id}<small>{record.initiator}</small><DemoBadge>{record.source}</DemoBadge></div></td>
          <td className="mono-cell">{record.recipient}</td><td className="amount-cell">{record.maxAmountNear} <small>NEAR</small></td><td>{record.expiresAt}</td>
          <td><StatusBadge status={record.status} /></td><td>{record.status === 'ACTIVE' && <button className="text-action" onClick={() => setRevokeTarget(record)}>Revoke</button>}</td>
        </tr>)}</tbody></table></div> : <EmptyState icon="rules" title="No authorization rules" description="Create a local demo rule or connect a contract in Phase 2." />}
        <div className="panel-footnote"><Icon name="alert" size={15} />Contract does not currently expose a method to enumerate all authorization IDs.</div>
      </Panel>

      <Panel className="form-panel">
        <SectionHeading eyebrow="OWNER ACTION / SIMULATED" title="Create authorization" detail="Set the initiator, destination, spending cap, and expiry." />
        <form className="auth-form" onSubmit={createAuthorization} noValidate>
          <Field label="Authorized initiator" hint="The account that may call the payment method."><input name="initiator" autoComplete="off" placeholder="agent-account.near" required /></Field>
          <Field label="Approved recipient"><input name="recipient" autoComplete="off" placeholder="vendor-account.near" required /></Field>
          <Field label="Maximum amount"><div className="input-suffix"><input name="amount" inputMode="decimal" placeholder="0.00" required /><span>NEAR</span></div></Field>
          <Field label="Authorization expires"><input name="expiry" type="date" required /></Field>
          {formError && <p className="form-message form-error" role="alert"><Icon name="alert" size={15} />{formError}</p>}
          {formNotice && <p className="form-message form-success" role="status"><Icon name="check" size={15} />{formNotice}</p>}
          <Button type="submit" variant="primary" className="full-button"><Icon name="plus" size={16} />Create demo rule</Button>
          <p className="form-disclaimer">Demo only. This action does not sign or submit a NEAR transaction.</p>
        </form>
      </Panel>
    </div>
    {revokeTarget && <ConfirmDialog title="Revoke authorization?" description={`The demo record “${revokeTarget.id}” will be marked revoked in local UI state. This will not submit an on-chain transaction.`} onCancel={() => setRevokeTarget(null)} onConfirm={confirmRevoke} />}
  </>;
}

function ConfirmDialog({ title, description, onCancel, onConfirm }: { title: string; description: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
    <div className="dialog-icon"><Icon name="alert" size={20} /></div><h2 id="confirm-title">{title}</h2><p>{description}</p><div className="dialog-actions"><Button onClick={onCancel}>Cancel</Button><Button variant="danger" onClick={onConfirm}>Confirm demo action</Button></div>
  </section></div>;
}

function TransactionsPage() {
  const activities = demoDataSource.getRecentActivity();
  const [filter, setFilter] = useState<'ALL' | PaymentStatus>('ALL');
  const filtered = useMemo(() => filter === 'ALL' ? activities : activities.filter((activity) => activity.status === filter), [activities, filter]);
  const filters: Array<'ALL' | PaymentStatus> = ['ALL', 'PENDING', 'EXECUTED', 'FAILED', 'DENIED'];

  return <>
    <PageIntro eyebrow="PAYMENT ACTIVITY / 03" title="Transactions" description="Follow each request from initiation through its asynchronous contract outcome." />
    <DataNotice>Illustrative events only · no historical on-chain activity is queried.</DataNotice>
    <Panel className="transactions-panel">
      <div className="table-toolbar"><div><div className="eyebrow">ACTIVITY STREAM</div><h2>Payment lifecycle</h2></div><div className="filter-tabs" role="group" aria-label="Filter transaction status">{filters.map((value) => <button key={value} className={filter === value ? 'filter-active' : ''} onClick={() => setFilter(value)}>{value === 'ALL' ? 'All activity' : value}</button>)}</div></div>
      <div className="transaction-list">{filtered.map((item) => <TransactionRow key={item.id} item={item} />)}{!filtered.length && <EmptyState icon="activity" title={`No ${filter.toLowerCase()} items`} description="There are no matching illustrative records." />}</div>
    </Panel>
    <div className="pending-explainer"><div className="pending-icon"><Icon name="clock" size={19} /></div><div><div className="pending-title">PENDING means unresolved</div><p>A payment request is not complete when it is initiated. The contract settles it after the transfer callback. If that callback fails, the transfer can remain pending indefinitely and its reserved balance stays locked.</p></div><DemoBadge>CONTRACT BEHAVIOR</DemoBadge></div>
    <p className="history-limitation"><Icon name="alert" size={15} />The current contract does not expose complete payment history. A live history view needs an approved event-indexing source or a separately designed contract API.</p>
  </>;
}

function TransactionRow({ item }: { item: PaymentActivity }) {
  const icon = item.status === 'DENIED' ? 'close' : item.status === 'PENDING' ? 'clock' : item.status === 'FAILED' ? 'alert' : 'check';
  return <div className="transaction-row"><div className={`transaction-icon transaction-${item.status.toLowerCase()}`}><Icon name={icon} size={17} /></div><div className="transaction-description"><strong>{item.title}</strong><span>Recipient <b>{item.recipient}</b></span><small>{item.detail}</small></div><div className="transaction-state"><StatusBadge status={item.status} /><DemoBadge /></div><div className="transaction-value"><strong>{item.amountNear} <small>NEAR</small></strong><span>{item.occurredAt}</span></div></div>;
}

function SecurityPage({ vaultRead }: { vaultRead: VaultReadResult<VaultStateView> | { status: 'loading' } }) {
  const isLive = vaultRead.status === 'available';
  const snapshot = isLive ? toVaultSnapshot(vaultRead.value) : demoDataSource.getSnapshot();
  const denialSummary = demoDataSource.getDenialSummary();
  const denials = demoDataSource.getRecentActivity().filter((activity) => activity.status === 'DENIED');

  return <>
    <PageIntro eyebrow="MONITORING / 04" title="Security Center" description="Review contract-reported enforcement signals and unresolved payment state." />
    <DataNotice>{isLive ? 'Vault state read from configured NEAR RPC · denial categories and activity remain demo fixtures' : undefined}</DataNotice>
    <AdapterWarning state={vaultRead} />
    <Panel className={`security-banner ${snapshot.frozen ? 'security-banner-frozen' : ''}`}>
      <div className="security-banner-icon"><Icon name={snapshot.frozen ? 'lock' : 'shield'} size={22} /></div>
      <div className="security-banner-copy"><div className="eyebrow">VAULT ENFORCEMENT STATE</div><h2>{snapshot.frozen ? 'Vault frozen' : 'Vault active'}</h2><p>{snapshot.frozen ? 'New payment requests are blocked in this state.' : 'New requests may be evaluated against configured authorizations.'} {isLive ? 'State read from configured NEAR RPC.' : 'Using illustrative contract state.'}</p></div>
      <DemoBadge>{isLive ? 'ON-CHAIN READ' : 'DEMO FIXTURE'}</DemoBadge>
    </Panel>

    <div className="security-metrics"><SecurityMetric label="Consecutive violations" value={`${snapshot.consecutiveViolations} / ${snapshot.maxConsecutiveViolations}`} detail={isLive ? 'Read from configured NEAR RPC' : 'Illustrative freeze threshold'} tone="amber" source={isLive ? 'ON-CHAIN READ' : 'DEMO FIXTURE'} /><SecurityMetric label="Persisted denials" value={snapshot.persistedDenialCount} detail={isLive ? 'Contract-reported total' : 'Configured-initiator records · demo'} tone="red" source={isLive ? 'ON-CHAIN READ' : 'DEMO FIXTURE'} /><SecurityMetric label="Pending transfer reserve" value="5.00 NEAR" detail="May remain locked if callback fails" tone="amber" source="DEMO FIXTURE" /></div>

    <div className="security-grid">
      <Panel><SectionHeading eyebrow="DENIAL AGGREGATES" title="Why requests were denied" detail="Illustrative per-category counts." /><div className="denial-table">{denialSummary.map((entry) => <div className="denial-table-row" key={entry.category}><span><span className="denial-led" />{entry.category}</span><strong>{entry.count.toString().padStart(2, '0')}</strong><DemoBadge /></div>)}</div><div className="panel-footnote">Persistent contract denial detail is limited to the latest 100 eligible records.</div></Panel>
      <Panel><SectionHeading eyebrow="RETAINED RECORDS" title="Recent denials" detail="Records from the bounded denial log." />{denials.length ? <div className="retained-denials">{denials.map((entry) => <div className="retained-row" key={entry.id}><div className="retained-icon"><Icon name="close" size={15} /></div><div><strong>{entry.title}</strong><span>{entry.detail}</span><small>{entry.occurredAt} · {entry.source}</small></div><span className="retained-amount">{entry.amountNear} NEAR</span></div>)}</div> : <EmptyState icon="check" title="No retained denials" description="There are no denial records to display." />}</Panel>
    </div>

    <Panel className="pending-warning"><div className="warning-symbol"><Icon name="alert" size={18} /></div><div><div className="eyebrow">ATTENTION REQUIRED · DEMO FIXTURE</div><h3>One transfer is still pending</h3><p>Freezing the vault does not cancel a transfer already scheduled. A callback failure can leave its authorization and reserved balance locked; there is no safe owner release action in the current contract.</p></div><StatusBadge status="PENDING" /></Panel>
  </>;
}

function SecurityMetric({ label, value, detail, tone, source }: { label: string; value: string; detail: string; tone: string; source: string }) {
  return <Panel className={`security-metric security-metric-${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small><DemoBadge>{source}</DemoBadge></Panel>;
}

function SettingsPage({ vaultRead }: { vaultRead: VaultReadResult<VaultStateView> | { status: 'loading' } }) {
  const isLive = vaultRead.status === 'available';
  return <>
    <PageIntro eyebrow="CONFIGURATION / 05" title="Vault settings" description="Review the connection context before any owner-authorized action is enabled." />
    <DataNotice>{isLive ? 'Read-only connection responding · owner operations still require a wallet' : contractAccountId ? 'Contract account configured but not yet readable' : 'No contract account configured; demo fixtures are shown'}</DataNotice>
    <AdapterWarning state={vaultRead} />
    <div className="settings-grid">
      <Panel className="settings-panel"><SectionHeading eyebrow="CONNECTION" title="Wallet & network" detail="Wallet actions will be added in Phase 2." />
        <div className="setting-row"><div className="setting-icon"><Icon name="wallet" size={18} /></div><div><strong>Owner wallet</strong><span>No wallet connected</span></div><span className="setting-state">NOT CONNECTED</span></div>
        <div className="setting-row"><div className="setting-icon"><Icon name="external" size={17} /></div><div><strong>RPC endpoint</strong><span>{rpcEndpoint}</span></div><span className="setting-state">{isLive ? 'RESPONDING' : contractAccountId ? 'UNAVAILABLE' : 'READ ONLY'}</span></div>
        <div className="setting-row"><div className="setting-icon"><Icon name="shield" size={18} /></div><div><strong>Contract account</strong><span>{contractAccountId || 'Not configured'}</span></div><span className="setting-state">{isLive ? 'READABLE' : contractAccountId ? 'UNVERIFIED' : 'NOT CONFIGURED'}</span></div>
        <div className="settings-note"><Icon name="alert" size={16} /><p>No wallet is connected and no owner operation is enabled. Contract reads are public; demo fixtures remain visible when live state is unavailable.</p></div>
      </Panel>
      <Panel className="settings-panel"><SectionHeading eyebrow="OWNER CONTROLS" title="Vault operations" detail="Unavailable until wallet and contract integration are configured." />
        <div className="operation-placeholder"><div className="operation-heading"><div className="operation-icon operation-amber"><Icon name="lock" size={17} /></div><div><strong>Freeze / unfreeze vault</strong><span>Owner-signed contract call</span></div></div><Button disabled title="Wallet and contract integration are not configured">Connect wallet to manage</Button></div>
        <div className="operation-placeholder"><div className="operation-heading"><div className="operation-icon"><Icon name="arrow" size={17} /></div><div><strong>Withdraw funds</strong><span>Owner-signed contract call · reserved balance protected</span></div></div><Button disabled title="Wallet and contract integration are not configured">Connect wallet to withdraw</Button></div>
        <div className="operation-disclaimer">These controls are intentionally disabled. No operation has been submitted or represented as successful.</div>
      </Panel>
    </div>
    <Panel className="settings-security-note"><div className="notice-shield"><Icon name="shield" size={17} /></div><div><strong>Keep agent authority scoped.</strong><p>BastionPro is designed to enforce payment rules in the contract. The agent must not receive the owner’s unrestricted wallet credentials.</p></div><DemoBadge /></Panel>
  </>;
}

export default App;

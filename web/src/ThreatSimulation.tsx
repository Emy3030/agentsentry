import { useState } from 'react';
import { demoDataSource } from './demoData';
import { Button, DemoBadge, Icon, Panel, StatusBadge } from './components';
import './threat-simulation.css';

type SimulationStage = 0 | 1 | 2 | 3 | 4;

const scenario = {
  initiator: 'procurement-agent.near',
  approvedRecipient: 'cloudservices.near',
  invoiceRecipient: 'attacker.near',
  amountNear: '5.00',
  maximumNear: '10.00',
  authorizationId: 'sim_auth_cloud_invoice_01',
  validUntil: '01 Dec 2026',
} as const;

const stages = [
  { title: 'Payment proposed', subtitle: 'Untrusted request enters the boundary' },
  { title: 'Authorization checked', subtitle: 'Compare the request with owner policy' },
  { title: 'Contract decision', subtitle: 'Reject the recipient mismatch' },
  { title: 'Vault protected', subtitle: 'No payment is executed' },
] as const;

const nextActions: Record<Exclude<SimulationStage, 0 | 4>, string> = {
  1: 'Check authorization',
  2: 'Show contract decision',
  3: 'Verify vault protection',
};

export function ThreatSimulation() {
  const [stage, setStage] = useState<SimulationStage>(0);
  const illustrativeBalance = demoDataSource.getSnapshot().vaultBalanceNear;

  function advance() {
    setStage((current) => (current < 4 ? (current + 1) as SimulationStage : current));
  }

  function reset() {
    setStage(0);
  }

  const started = stage > 0;
  const rejected = stage >= 2;
  const complete = stage === 4;

  return (
    <Panel className="threat-simulation">
      <div className="simulation-heading">
        <div>
          <div className="simulation-eyebrow"><span className="simulation-eyebrow-mark"><Icon name="shield" size={14} /></span>SECURITY SCENARIO / INTERACTIVE</div>
          <h2>Poisoned invoice defense</h2>
          <p>Watch the contract reject an agent request that redirects an approved payment.</p>
        </div>
        <DemoBadge>ILLUSTRATIVE SIMULATION</DemoBadge>
      </div>

      <div className="simulation-alert" role="note">
        <Icon name="alert" size={15} />
        <span>Frontend demonstration only. No wallet, NEAR RPC, or blockchain transaction is involved.</span>
      </div>

      <div className="simulation-layout">
        <div className="simulation-main">
          <ol className="simulation-steps" aria-label="Simulation progress">
            {stages.map((item, index) => {
              const number = (index + 1) as 1 | 2 | 3 | 4;
              const reached = stage >= number;
              const isCurrent = stage === number;
              const isRejected = number === 2 && rejected;
              return (
                <li className={`simulation-step ${reached ? 'step-reached' : ''} ${isCurrent ? 'step-current' : ''} ${isRejected ? 'step-rejected' : ''}`} key={item.title} aria-current={isCurrent ? 'step' : undefined}>
                  <span className="step-number">{reached ? <Icon name={isRejected ? 'close' : 'check'} size={13} /> : `0${number}`}</span>
                  <span className="step-copy"><strong>{item.title}</strong><small>{item.subtitle}</small></span>
                  {isCurrent && <span className="step-live">CURRENT</span>}
                </li>
              );
            })}
          </ol>

          {!started && <div className="simulation-idle">
            <div className="idle-icon"><Icon name="activity" size={21} /></div>
            <div><strong>Ready to inspect the request</strong><p>An agent proposes a 5.00 NEAR payment using an invoice with an unapproved recipient.</p></div>
          </div>}

          {stage >= 1 && <section className={`simulation-stage-card ${stage === 1 ? 'stage-active' : 'stage-complete'}`} aria-labelledby="stage-proposed-title">
            <div className="stage-card-heading"><span className="stage-index">01</span><div><div className="stage-kicker">STAGE 1 · PAYMENT PROPOSED</div><h3 id="stage-proposed-title">The agent submits an invoice request</h3></div><StatusBadge status="PROPOSED" /></div>
            <div className="request-detail-grid">
              <div className="request-detail"><span>REQUESTING AGENT</span><strong>{scenario.initiator}</strong></div>
              <div className="request-detail request-amount"><span>REQUESTED AMOUNT</span><strong>{scenario.amountNear} <small>NEAR</small></strong></div>
              <div className="request-detail request-recipient"><span>INVOICE RECIPIENT <b>UNTRUSTED INPUT</b></span><strong><Icon name="alert" size={14} />{scenario.invoiceRecipient}</strong></div>
            </div>
            <div className="invoice-source"><span className="invoice-file"><Icon name="activity" size={14} /></span><span><strong>invoice_7841.pdf</strong><small>Recipient supplied by invoice · not an authorization source</small></span><DemoBadge>UNTRUSTED</DemoBadge></div>
          </section>}

          {stage >= 2 && <section className="simulation-stage-card stage-rejected-card" aria-labelledby="stage-check-title">
            <div className="stage-card-heading"><span className="stage-index">02</span><div><div className="stage-kicker">STAGE 2 · AUTHORIZATION CHECKED</div><h3 id="stage-check-title">Owner policy does not match the invoice</h3></div><StatusBadge status="DENIED" /></div>
            <div className="policy-compare">
              <div className="compare-row"><span>Owner-approved recipient</span><strong className="compare-approved"><Icon name="check" size={14} />{scenario.approvedRecipient}</strong></div>
              <div className="compare-divider"><span /><b>RECIPIENT CHECK</b><span /></div>
              <div className="compare-row compare-danger"><span>Requested invoice recipient</span><strong><Icon name="close" size={14} />{scenario.invoiceRecipient}</strong></div>
            </div>
            <div className="policy-checks">
              <div className="policy-check policy-check-pass"><Icon name="check" size={14} /><span>Amount within limit</span><strong>{scenario.amountNear} ≤ {scenario.maximumNear} NEAR</strong></div>
              <div className="policy-check policy-check-pass"><Icon name="check" size={14} /><span>Authorization valid</span><strong>Expires {scenario.validUntil}</strong></div>
              <div className="policy-check policy-check-fail"><Icon name="close" size={14} /><span>Recipient approved</span><strong>Mismatch</strong></div>
            </div>
          </section>}

          {stage >= 3 && <section className="simulation-stage-card decision-card" aria-labelledby="stage-decision-title" role="status">
            <div className="decision-symbol"><Icon name="close" size={22} /></div>
            <div className="decision-copy"><div className="stage-kicker">STAGE 3 · NEAR CONTRACT DECISION · ILLUSTRATIVE</div><h3 id="stage-decision-title">REJECTED</h3><p>The requested recipient <strong>{scenario.invoiceRecipient}</strong> violates the owner-approved authorization for <strong>{scenario.approvedRecipient}</strong>. The amount is within the limit, but the recipient rule fails.</p></div>
            <DemoBadge>SIMULATED</DemoBadge>
          </section>}

          {stage >= 4 && <section className="simulation-stage-card protected-card" aria-labelledby="stage-protected-title" role="status">
            <div className="protected-icon"><Icon name="shield" size={21} /></div>
            <div className="protected-copy"><div className="stage-kicker">STAGE 4 · VAULT PROTECTION</div><h3 id="stage-protected-title">No payment was executed</h3><p>The rejected request scheduled no transfer. This illustrative vault balance is unchanged; no funds moved.</p></div>
            <div className="balance-proof"><span>ILLUSTRATIVE BALANCE</span><strong>{illustrativeBalance} <small>NEAR</small></strong><div><span className="balance-equals">=</span> unchanged</div></div>
          </section>}

          <div className="simulation-controls">
            {!started ? <Button variant="primary" className="run-simulation-button" onClick={advance}><Icon name="spark" size={16} />Run Attack Simulation<Icon name="arrow" size={15} /></Button> : !complete ? <Button variant="primary" onClick={advance}>Continue · {nextActions[stage as 1 | 2 | 3]}<Icon name="arrow" size={15} /></Button> : <div className="simulation-finished"><Icon name="check" size={15} />Scenario complete · request blocked</div>}
            {started && <button className="simulation-reset" onClick={reset}><Icon name="close" size={14} />Reset simulation</button>}
            {!started && <span className="control-hint">4 quick steps · no network connection</span>}
          </div>
        </div>

        <aside className="simulation-rule" aria-label="Authorization rule being evaluated">
          <div className="rule-topline"><span className="rule-shield"><Icon name="lock" size={15} /></span><span>OWNER POLICY</span><DemoBadge>DEMO RULE</DemoBadge></div>
          <h3>Authorization rule</h3>
          <p>This is the rule evaluated against the invoice request.</p>
          <dl className="rule-details">
            <div><dt>Authorization ID</dt><dd>{scenario.authorizationId}</dd></div>
            <div><dt>Authorized initiator</dt><dd>{scenario.initiator}</dd></div>
            <div><dt>Approved recipient</dt><dd className="rule-recipient">{scenario.approvedRecipient}</dd></div>
            <div><dt>Maximum amount</dt><dd>{scenario.maximumNear} NEAR</dd></div>
            <div><dt>Valid through</dt><dd>{scenario.validUntil}</dd></div>
          </dl>
          <div className={`rule-evaluation ${rejected ? 'rule-evaluation-rejected' : ''}`}>
            <span className="evaluation-icon"><Icon name={rejected ? 'close' : 'shield'} size={15} /></span>
            <span><strong>{rejected ? 'Recipient check failed' : 'Rule ready to evaluate'}</strong><small>{rejected ? 'Recipient mismatch is sufficient to reject.' : 'The invoice recipient is untrusted until checked.'}</small></span>
          </div>
          <div className="rule-footer"><Icon name="lock" size={12} />Rule authority belongs to the contract</div>
        </aside>
      </div>

      <div className="simulation-footnote"><span className="simulation-footnote-line" />This simulation illustrates the policy boundary. It does not call the Rust contract or prove a live blockchain outcome.</div>
    </Panel>
  );
}

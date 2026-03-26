import { Link } from 'react-router-dom';

export default function DashboardActionCard({
  icon,
  title,
  subtitle,
  badge,
  topBadge,
  hint,
  to,
  onClick,
  disabled = false,
  emphasized = false,
}) {
  const Icon = icon;
  const className = [
    'dashboard-action-card',
    emphasized ? 'is-primary' : '',
    disabled ? 'is-disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      <div className="dashboard-action-top">
        <div className="dashboard-action-icon">
          <Icon size={24} />
        </div>
        {topBadge ? <span className="dashboard-action-badge dashboard-action-badge-top">{topBadge}</span> : null}
      </div>
      <div className="dashboard-action-copy">
        <div className="dashboard-action-head">
          <strong>{title}</strong>
          {badge ? <span className="dashboard-action-badge">{badge}</span> : null}
        </div>
        <span>{subtitle}</span>
      </div>
      {hint ? <small>{hint}</small> : null}
    </>
  );

  if (to && !disabled) {
    return (
      <Link className={className} to={to}>
        {content}
      </Link>
    );
  }

  return (
    <button className={className} type="button" onClick={onClick} disabled={disabled}>
      {content}
    </button>
  );
}

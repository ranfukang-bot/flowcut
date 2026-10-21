"use client";


export function formatTime(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function PageIntro({
  title,
  text,
  action,
  actionIcon = "＋",
  actionTone = "primary",
  onAction,
}: {
  title: string;
  text: string;
  action?: string;
  actionIcon?: string;
  actionTone?: "primary" | "secondary";
  onAction?: () => void;
}) {
  return <div className="page-intro"><div><h2>{title}</h2><p>{text}</p></div>{action && <button className={actionTone} onClick={onAction}>{actionIcon} {action}</button>}</div>;
}

export function ModalHead({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return <div className="modal-head"><div><h2>{title}</h2><p>{text}</p></div><button type="button" onClick={onClose}>×</button></div>;
}

export function EmptyState({ icon, title, text, action, onAction }: { icon: string; title: string; text: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{text}</p>{action && <button className="secondary" onClick={onAction}>{action}</button>}</div>;
}

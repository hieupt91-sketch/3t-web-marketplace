'use client';

import { useT } from '@/lib/i18n';

const STEPS = ['ui.import.stepper.resource', 'ui.import.stepper.configure', 'ui.import.stepper.build', 'ui.import.stepper.check'];

export function stepperIndex(status: string): number {
  if (status === 'received' || status === 'inspecting' || status === 'needs_configuration') return 1;
  if (status === 'queued' || status === 'building' || status === 'provisioning') return 2;
  return 3;
}

/** "Tài nguyên → Cấu hình → Xây demo → Kiểm tra" (docs/05 §13 A03–A05). */
export function ImportStepper({ current, failed = false }: { current: number; failed?: boolean }) {
  const { t } = useT();
  return (
    <ol className="row" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 'var(--space-2)' }}>
      {STEPS.map((key, index) => {
        const state = index < current ? 'done' : index === current ? (failed ? 'error' : 'current') : 'todo';
        return (
          <li key={key} aria-current={index === current ? 'step' : undefined} className={`badge badge--${state === 'done' ? 'success' : state === 'current' ? 'info' : state === 'error' ? 'error' : 'neutral'}`}>
            <span aria-hidden="true">{state === 'done' ? '✓' : state === 'error' ? '×' : index + 1}</span>
            {t(key)}
            <span className="visually-hidden">({t(`ui.import.stepper.state_${state}`)})</span>
          </li>
        );
      })}
    </ol>
  );
}

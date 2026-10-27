'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { useT } from '@/lib/i18n';

/** Password with show/hide toggle; works with password managers (autocomplete hints). */
export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { t } = useT();
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <input {...props} type={visible ? 'text' : 'password'} className="input" />
      <button type="button" className="button button--secondary" onClick={() => setVisible((v) => !v)} aria-pressed={visible} aria-controls={props.id}>
        {visible ? t('ui.auth.hide_password') : t('ui.auth.show_password')}
      </button>
    </div>
  );
}

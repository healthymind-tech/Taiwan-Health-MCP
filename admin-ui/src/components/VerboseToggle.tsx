// Per-import "verbose logging" switch. When on, the next import job records
// per-batch debug detail (visible via the 'debug' filter in the job log viewer).

export function VerboseToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label
      className="switch"
      title="Record per-batch debug detail for the next import (view it with the 'debug' filter in the job log)."
    >
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch__track" />
      <span className="switch__label">Verbose logs</span>
    </label>
  );
}

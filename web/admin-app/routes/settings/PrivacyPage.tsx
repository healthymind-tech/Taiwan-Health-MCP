import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { toast } from "../../components/toast";
import { PasskeysCard } from "./PasskeysCard";

export function PrivacyPage(): JSX.Element {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const matches = newPassword === confirmPassword;

  const change = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/admin/api/privacy/password", {
      current_password: currentPassword,
      new_password: newPassword,
    }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password changed");
    },
    onError: (error) => toast.error(String(error)),
  });

  return (
    <>
      <div className="module-card">
        <div className="module-card__head">
          <div>
            <h3 className="subhead" style={{ margin: 0 }}>Password</h3>
            <div className="muted small">Change the password for the current admin account.</div>
          </div>
        </div>
        <form
          className="settings-grid"
          onSubmit={(event) => {
            event.preventDefault();
            if (!matches) {
              toast.error("New passwords do not match");
              return;
            }
            change.mutate();
          }}
        >
          <label className="settings-field">
            <span className="settings-field__label">Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              required
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              required
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              required
              aria-invalid={Boolean(confirmPassword) && !matches}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            {confirmPassword && !matches && <span className="field-error small">Passwords do not match.</span>}
          </label>
          <div className="settings-form-action">
            <button
              type="submit"
              className="btn"
              disabled={change.isPending || !currentPassword || !newPassword || !matches}
            >
              {change.isPending ? "Changing…" : "Change password"}
            </button>
          </div>
        </form>
      </div>
      <PasskeysCard />
    </>
  );
}

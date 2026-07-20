"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Trash2, UserPlus, Users } from "lucide-react";
import {
  bootstrapNamedAdministrator,
  createNamedUser,
  deleteNamedUser,
  resetNamedUserPassword,
  setNamedUserRole,
  setNamedUserStatus,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const roles = ["administrator", "operator", "viewer", "auditor"];

function ActionMessage({ error, success }) {
  if (!error && !success) return null;
  return (
    <div
      role="status"
      className={`rounded-md p-3 text-sm ${
        error
          ? "bg-destructive/10 text-destructive"
          : "bg-emerald-500/10 text-emerald-500"
      }`}
    >
      {error || success}
    </div>
  );
}

function PasswordInputWithToggle({ id, name, label }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          minLength={8}
          required
          autoComplete="new-password"
          className="pr-10"
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setVisible((current) => !current)}
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
        >
          {visible ? (
            <EyeOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Eye className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}

export function UserManagement({ initialState }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [addUserError, setAddUserError] = useState("");
  const [resetUserId, setResetUserId] = useState(null);
  const [deleteUserId, setDeleteUserId] = useState(null);

  function run(action, formData, message, form, onSuccess) {
    setError("");
    setSuccess("");
    startTransition(async () => {
      const result = await action(formData);
      if (!result?.success) {
        setError(result?.error || "The user-management action failed.");
        return;
      }
      form?.reset();
      setSuccess(message);
      onSuccess?.();
      router.refresh();
    });
  }

  if (!initialState.bootstrapped) {
    return (
      <section className="space-y-4 rounded-lg border border-border p-4 sm:p-6">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="h-5 w-5 text-primary" />
            Create your named administrator
          </h3>
          <p className="text-sm text-muted-foreground">
            This one-time step creates the first database-backed account. Your
            current administrator password is required and remains available as
            a compatibility login.
          </p>
        </div>
        <ActionMessage error={error} success={success} />
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              bootstrapNamedAdministrator,
              new FormData(event.currentTarget),
              "Named administrator created."
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="ownerUsername">Username</Label>
            <Input id="ownerUsername" name="username" minLength={3} maxLength={64} required autoComplete="username" placeholder="prsmith777" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ownerDisplayName">Display name</Label>
            <Input id="ownerDisplayName" name="displayName" maxLength={120} required autoComplete="name" placeholder="Paul Smith" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="ownerCurrentPassword">Current administrator password</Label>
            <Input id="ownerCurrentPassword" name="currentPassword" type="password" required autoComplete="current-password" />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={isPending}>
              {isPending ? "Creating..." : "Create named administrator"}
            </Button>
          </div>
        </form>
      </section>
    );
  }

  if (!initialState.canManageUsers) {
    return (
      <section className="space-y-2 rounded-lg border border-border p-4 sm:p-6">
        <h3 className="text-lg font-semibold">User management</h3>
        <p className="text-sm text-muted-foreground">
          Signed in as {initialState.currentUser.displayName}. An administrator
          account is required to manage users.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-6 rounded-lg border border-border p-4 sm:p-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Users className="h-5 w-5 text-primary" /> User management
        </h3>
        <p className="text-sm text-muted-foreground">
          Signed in as {initialState.currentUser.displayName} (@{initialState.currentUser.username}).
          Role and status changes take effect on the user&apos;s next request.
        </p>
      </div>
      <ActionMessage error={error} success={success} />

      <div className="space-y-3">
        {initialState.users.map((user) => {
          const isCurrent = user.id === initialState.currentUser.id;
          return (
            <div key={user.id} className="grid gap-3 rounded-md border border-border p-4 lg:grid-cols-[minmax(12rem,1fr)_10rem_auto] lg:items-center">
              <div>
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {user.displayName}
                  {isCurrent && <Badge variant="secondary">You</Badge>}
                  <Badge variant={user.status === "active" ? "default" : "outline"}>{user.status}</Badge>
                  {user.mustChangePassword && (
                    <Badge variant="outline">Password change required</Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">@{user.username}</p>
              </div>
              <Select
                value={user.roles[0] || "viewer"}
                disabled={isPending}
                onValueChange={(role) => {
                  const data = new FormData();
                  data.set("userId", String(user.id));
                  data.set("role", role);
                  run(setNamedUserRole, data, `${user.displayName}'s role updated.`);
                }}
              >
                <SelectTrigger aria-label={`Role for ${user.displayName}`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roles.map((role) => <SelectItem key={role} value={role}>{role[0].toUpperCase() + role.slice(1)}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-2 lg:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending || isCurrent}
                  onClick={() => {
                    const data = new FormData();
                    data.set("userId", String(user.id));
                    data.set("status", user.status === "active" ? "disabled" : "active");
                    run(setNamedUserStatus, data, `${user.displayName}'s status updated.`);
                  }}
                >
                  {user.status === "active" ? "Disable" : "Enable"}
                </Button>
                {!isCurrent && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isPending}
                    onClick={() => setResetUserId(user.id)}
                  >
                    Reset password
                  </Button>
                )}
                {!isCurrent && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={isPending}
                    onClick={() => setDeleteUserId(user.id)}
                  >
                    <Trash2 className="mr-1 h-4 w-4" /> Delete
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog
        open={resetUserId !== null}
        onOpenChange={(open) => {
          if (!open) setResetUserId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset user password</DialogTitle>
            <DialogDescription>
              Enter a new password for this user and confirm the action with your
              own administrator password. The user&apos;s active sessions will be revoked.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              data.set("userId", String(resetUserId));
              run(
                resetNamedUserPassword,
                data,
                "Password reset. The user's sessions were revoked.",
                form,
                () => setResetUserId(null)
              );
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="resetPassword">New password</Label>
              <Input id="resetPassword" name="password" type="password" minLength={8} required autoComplete="new-password" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="resetConfirmPassword">Confirm new password</Label>
              <Input id="resetConfirmPassword" name="confirmPassword" type="password" minLength={8} required autoComplete="new-password" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="resetAdministratorPassword">Your administrator password</Label>
              <Input id="resetAdministratorPassword" name="currentPassword" type="password" required autoComplete="current-password" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setResetUserId(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Resetting..." : "Reset password"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteUserId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteUserId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete user account</DialogTitle>
            <DialogDescription>
              This permanently removes the login, role, sessions, and credentials.
              Append-only audit history is retained under a deleted-user record.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              data.set("userId", String(deleteUserId));
              run(
                deleteNamedUser,
                data,
                "User account deleted.",
                form,
                () => setDeleteUserId(null)
              );
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="deleteConfirmUsername">
                Type the username to confirm
              </Label>
              <Input
                id="deleteConfirmUsername"
                name="confirmUsername"
                required
                autoComplete="off"
                placeholder={
                  initialState.users.find((user) => user.id === deleteUserId)
                    ?.username || "username"
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="deleteAdministratorPassword">
                Your administrator password
              </Label>
              <Input
                id="deleteAdministratorPassword"
                name="currentPassword"
                type="password"
                required
                autoComplete="current-password"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDeleteUserId(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={isPending}>
                {isPending ? "Deleting..." : "Delete account"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <form
        className="grid gap-4 border-t border-border pt-6 sm:grid-cols-2"
        onChange={() => setAddUserError("")}
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          setAddUserError("");
          if (data.get("password") !== data.get("confirmPassword")) {
            setSuccess("");
            setError("");
            setAddUserError("Temporary passwords do not match.");
            return;
          }
          run(createNamedUser, data, "User created.", form);
        }}
      >
        <h4 className="flex items-center gap-2 font-semibold sm:col-span-2"><UserPlus className="h-4 w-4 text-primary" /> Add user</h4>
        <div className="space-y-2"><Label htmlFor="newUsername">Username</Label><Input id="newUsername" name="username" required minLength={3} /></div>
        <div className="space-y-2"><Label htmlFor="newDisplayName">Display name</Label><Input id="newDisplayName" name="displayName" required /></div>
        <PasswordInputWithToggle
          id="newUserPassword"
          name="password"
          label="Temporary password"
        />
        <PasswordInputWithToggle
          id="newUserConfirmPassword"
          name="confirmPassword"
          label="Confirm temporary password"
        />
        <div className="space-y-2">
          <Label htmlFor="newUserRole">Role</Label>
          <Select name="role" defaultValue="viewer">
            <SelectTrigger id="newUserRole"><SelectValue /></SelectTrigger>
            <SelectContent>{roles.map((role) => <SelectItem key={role} value={role}>{role[0].toUpperCase() + role.slice(1)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-3 sm:col-span-2 sm:flex-row sm:items-center">
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : "Add user"}
          </Button>
          {addUserError && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {addUserError}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

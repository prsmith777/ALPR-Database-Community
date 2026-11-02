"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const blank = {
  camera_name: "",
  source: "",
  transport: "http",
  enabled: true,
  device_id: "",
  broker_id: "",
  topic_filter: "",
  qos: 1,
  processing_mode: "immediate",
  store_images: true,
  direction_in: "In",
  direction_out: "Out",
  roi_filter: "",
};
const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
async function api(url, data) {
  const response = await fetch(
    url,
    data === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
function Field({ label, children }) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
function date(value) {
  return value ? new Date(value).toLocaleString() : "No events yet";
}

export function CameraInputs() {
  const [inputs, setInputs] = useState([]);
  const [brokers, setBrokers] = useState([]);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [credential, setCredential] = useState(null);
  const [events, setEvents] = useState([]);
  const [listening, setListening] = useState(null);
  const [brokerDraft, setBrokerDraft] = useState(null);
  const [origin, setOrigin] = useState("");
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    const result = await api("/api/camera-inputs");
    setInputs(result.inputs);
    setBrokers(result.brokers);
    setLoaded(true);
  }, []);
  useEffect(() => {
    setOrigin(window.location.origin);
    void load().catch((error) => setMessage(error.message));
  }, [load]);
  useEffect(() => {
    if (!listening) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await api(`/api/camera-inputs/${listening.id}/events`);
        if (active) {
          setEvents(result.events);
          if (result.input)
            setInputs((current) =>
              current.map((input) =>
                input.id === result.input.id
                  ? { ...input, ...result.input }
                  : input,
              ),
            );
        }
      } catch (error) {
        if (active) setMessage(error.message);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    const deadline = setTimeout(() => {
      if (active) {
        setListening(null);
        setMessage("Listening finished. Recent events are shown below.");
      }
    }, 60000);
    return () => {
      active = false;
      clearInterval(timer);
      clearTimeout(deadline);
    };
  }, [listening, load]);
  const change = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const edit = (input) => {
    setDraft({ ...blank, ...input });
    setCredential(null);
    setMessage("");
    setBrokerDraft(null);
  };
  const endpoint = draft?.id
    ? `${origin}/api/camera-inputs/axis/${draft.id}`
    : "Save this camera to generate its destination URL.";
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await api("/api/camera-inputs", draft);
      setDraft({ ...blank, ...result.input });
      if (result.credential)
        setCredential({ id: result.input.id, secret: result.credential });
      await load();
      setMessage("Camera input saved. Existing history is preserved.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function addBroker() {
    setBusy(true);
    try {
      const result = await api("/api/mqtt/brokers", brokerDraft);
      await load();
      change("broker_id", result.data.id);
      setBrokerDraft(null);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function test(input) {
    setBusy(true);
    setMessage("");
    try {
      const result = await api(`/api/camera-inputs/${input.id}/test`, {});
      setMessage(result.ok ? result.message : result.error);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Camera inputs</CardTitle>
              <CardDescription>
                Choose where each camera supplies its plate recognition.
                Existing Blue Iris cameras work automatically.
              </CardDescription>
            </div>
            <Button onClick={() => edit(blank)}>Add camera input</Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="p-2">Camera</th>
                  <th className="p-2">Recognition source</th>
                  <th className="p-2">Delivery</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Last event</th>
                  <th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {inputs.map((input) => (
                  <tr
                    className="border-b"
                    key={input.id || `legacy-${input.camera_name}`}
                  >
                    <td className="p-2 font-medium">{input.camera_name}</td>
                    <td className="p-2">
                      {input.source === "axis"
                        ? "Axis License Plate Verifier"
                        : "Blue Iris"}
                    </td>
                    <td className="p-2 uppercase">{input.transport}</td>
                    <td className="p-2">
                      {input.enabled
                        ? input.legacy
                          ? "Existing input"
                          : input.connection_status
                        : "Disabled"}
                      {input.last_error ? (
                        <p className="max-w-xs text-destructive">
                          {input.last_error}
                        </p>
                      ) : null}
                    </td>
                    <td className="p-2">{date(input.last_received_at)}</td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => edit(input)}
                        >
                          Configure
                        </Button>
                        {input.id && input.source === "axis" ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setEvents([]);
                                setListening({ id: input.id });
                                setMessage(
                                  "Listening for camera events for 60 seconds. Trigger a real passage or use Axis’s Test button.",
                                );
                              }}
                            >
                              Listen for event
                            </Button>
                            {input.transport !== "http" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => test(input)}
                              >
                                Test MQTT
                              </Button>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {loaded && !inputs.length ? (
            <p className="py-6 text-muted-foreground">
              Connect your first camera using Add camera input. Existing Blue
              Iris feeds also appear automatically after their first read.
            </p>
          ) : null}
        </CardContent>
      </Card>
      {message ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          {message}
        </p>
      ) : null}
      {draft ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {draft.id || draft.legacy
                ? "Configure camera input"
                : "Add camera input"}
            </CardTitle>
            <CardDescription>
              Recognition comes from the selected source. Blue Iris recording
              and playback can be configured separately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-5">
              <Field label="Camera name">
                <Input
                  required
                  maxLength={30}
                  readOnly={Boolean(draft.id || draft.legacy)}
                  value={draft.camera_name}
                  onChange={(event) =>
                    change("camera_name", event.target.value)
                  }
                />
              </Field>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  Where does plate recognition come from?
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    [
                      "blue_iris",
                      "Blue Iris",
                      "Receive recognition results and alert images from Blue Iris.",
                    ],
                    [
                      "axis",
                      "Axis License Plate Verifier",
                      "Receive recognition results directly from the camera.",
                    ],
                  ].map(([value, title, description]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={draft.source === value}
                      className={`rounded-lg border p-4 text-left ${draft.source === value ? "border-primary bg-primary/5" : "border-border"}`}
                      onClick={() => change("source", value)}
                    >
                      <span className="block font-semibold">{title}</span>
                      <span className="text-sm text-muted-foreground">
                        {description}
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>
              {draft.source === "blue_iris" ? (
                <div className="space-y-3 rounded-lg border p-4 text-sm">
                  <p>
                    Send Blue Iris alert JSON to{" "}
                    <code>{origin}/api/plate-reads</code> with your existing
                    integration API key.
                  </p>
                  <p>
                    Use this camera name in the alert’s camera field. Existing
                    alert actions require no changes.
                  </p>
                  <Link
                    className="text-primary underline"
                    href="/settings/blue-iris"
                  >
                    Blue Iris connection settings
                  </Link>
                  <span> · </span>
                  <Link
                    className="text-primary underline"
                    href="/settings/security"
                  >
                    Integration API key
                  </Link>
                </div>
              ) : null}
              {draft.source === "axis" ? (
                <>
                  {draft.legacy ? (
                    <p className="rounded-md border p-3 text-sm">
                      Saving Axis as the source will stop accepting Blue Iris
                      recognition for this camera name. Existing records and
                      Blue Iris recording remain available.
                    </p>
                  ) : null}
                  <Field label="Camera serial number or MAC address">
                    <Input
                      required
                      value={draft.device_id || ""}
                      onChange={(event) =>
                        change("device_id", event.target.value)
                      }
                      placeholder="Enter this camera’s device identity"
                    />
                  </Field>
                  <Field label="Delivery method">
                    <select
                      className={selectClass}
                      value={draft.transport}
                      onChange={(event) =>
                        change("transport", event.target.value)
                      }
                    >
                      <option value="http">HTTP push</option>
                      <option value="mqtt">MQTT</option>
                      <option value="both">HTTP and MQTT (advanced)</option>
                    </select>
                  </Field>
                  {draft.transport !== "mqtt" ? (
                    <div className="space-y-3 rounded-lg border p-4 text-sm">
                      <p className="font-medium">
                        Axis → Integration → Push events
                      </p>
                      <p>
                        Choose HTTP POST, send New, Update and Lost events,
                        include images, and enable the camera’s Event buffer.
                      </p>
                      <Field label="Destination URL">
                        <Input
                          readOnly
                          value={endpoint}
                          onFocus={(event) => event.target.select()}
                        />
                      </Field>
                      <p>
                        Use an ALPR address reachable from the camera. The
                        address above comes from this browser; replace its host
                        if you use a different camera-facing address.
                      </p>
                      {draft.id ? (
                        <>
                          <p>
                            HTTP Basic username:{" "}
                            <code className="break-all">{draft.id}</code>
                          </p>
                          <p>
                            Use the generated source credential as the password.
                            Header authentication also accepts this credential
                            as x-api-key or Bearer.
                          </p>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={draft.rotate_credential === true}
                              onChange={(event) =>
                                change(
                                  "rotate_credential",
                                  event.target.checked,
                                )
                              }
                            />
                            Generate a replacement credential when saving
                          </label>
                        </>
                      ) : null}
                      <p>
                        Use HTTPS when the camera and ALPR network supports it.
                      </p>
                    </div>
                  ) : null}
                  {draft.transport !== "http" ? (
                    <div className="space-y-4 rounded-lg border p-4">
                      <Field label="MQTT broker">
                        <select
                          required
                          className={selectClass}
                          value={draft.broker_id || ""}
                          onChange={(event) =>
                            change("broker_id", event.target.value)
                          }
                        >
                          <option value="">Select broker</option>
                          {brokers.map((broker) => (
                            <option value={broker.id} key={broker.id}>
                              {broker.name} — {broker.broker}:{broker.port}
                              {broker.enabled ? "" : " (disabled)"}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          setBrokerDraft({
                            name: "",
                            broker: "",
                            port: 1883,
                            username: "",
                            password: "",
                            useTls: false,
                          })
                        }
                      >
                        Add MQTT broker
                      </Button>
                      <Field label="Incoming Axis topic or topic filter">
                        <Input
                          required
                          value={draft.topic_filter || ""}
                          onChange={(event) =>
                            change("topic_filter", event.target.value)
                          }
                          placeholder="Copy the camera’s ALPV.AllPlates publication topic"
                        />
                      </Field>
                      <Field label="Subscription QoS">
                        <select
                          className={selectClass}
                          value={draft.qos}
                          onChange={(event) =>
                            change("qos", Number(event.target.value))
                          }
                        >
                          <option value={1}>1 — retry delivery</option>
                          <option value={0}>0 — best effort</option>
                        </select>
                      </Field>
                      <p className="text-sm text-muted-foreground">
                        Also set the camera’s AllPlates publication to QoS 1,
                        with Retain set to None. ALPR uses its own persistent
                        client ID and imports only events matching this camera’s
                        identity.
                      </p>
                    </div>
                  ) : null}
                  {brokerDraft ? (
                    <div className="space-y-3 rounded-md border p-4">
                      <p className="font-medium">New MQTT broker</p>
                      {[
                        ["name", "Broker name"],
                        ["broker", "Hostname or IP"],
                        ["port", "Port"],
                        ["username", "Username"],
                        ["password", "Password"],
                      ].map(([key, label]) => (
                        <Field label={label} key={key}>
                          <Input
                            type={
                              key === "password"
                                ? "password"
                                : key === "port"
                                  ? "number"
                                  : "text"
                            }
                            value={brokerDraft[key]}
                            onChange={(event) =>
                              setBrokerDraft((current) => ({
                                ...current,
                                [key]: event.target.value,
                              }))
                            }
                          />
                        </Field>
                      ))}
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={brokerDraft.useTls}
                          onChange={(event) =>
                            setBrokerDraft((current) => ({
                              ...current,
                              useTls: event.target.checked,
                              port: event.target.checked ? 8883 : 1883,
                            }))
                          }
                        />
                        Use TLS with certificate verification
                      </label>
                      <Button type="button" disabled={busy} onClick={addBroker}>
                        Save broker
                      </Button>
                    </div>
                  ) : null}
                  <Field label="Axis ROI ID (optional)">
                    <Input
                      maxLength={30}
                      value={draft.roi_filter || ""}
                      onChange={(event) =>
                        change("roi_filter", event.target.value)
                      }
                      placeholder="Leave blank to accept every area of interest"
                    />
                  </Field>
                  <Field label="Detection handling">
                    <select
                      className={selectClass}
                      value={draft.processing_mode}
                      onChange={(event) =>
                        change("processing_mode", event.target.value)
                      }
                    >
                      <option value="immediate">
                        Immediate — first read, then corrections
                      </option>
                      <option value="final">
                        Finalized — wait for Lost or 30 seconds of inactivity
                      </option>
                    </select>
                  </Field>
                  <p className="text-sm text-muted-foreground">
                    Immediate alerts use the first recognition. Later
                    corrections update the read without sending the same passage
                    alert again. Finalized mode waits for the best available
                    result.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Axis in means">
                      <Input
                        maxLength={80}
                        value={draft.direction_in}
                        onChange={(event) =>
                          change("direction_in", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Axis out means">
                      <Input
                        maxLength={80}
                        value={draft.direction_out}
                        onChange={(event) =>
                          change("direction_out", event.target.value)
                        }
                      />
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.store_images}
                      onChange={(event) =>
                        change("store_images", event.target.checked)
                      }
                    />
                    Store images supplied with events
                  </label>
                </>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => change("enabled", event.target.checked)}
                />
                Enable this input
              </label>
              <div className="flex gap-3">
                <Button disabled={busy || !draft.source} type="submit">
                  {busy ? "Saving…" : "Save camera input"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setDraft(null);
                    setCredential(null);
                  }}
                >
                  Close
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {credential ? (
        <Card>
          <CardHeader>
            <CardTitle>Source credential</CardTitle>
            <CardDescription>
              Copy this credential now. It is shown only when generated.
              Replacing it requires updating the camera.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              aria-label="Generated source credential"
              readOnly
              value={credential.secret}
              onFocus={(event) => event.target.select()}
              autoComplete="off"
            />
            <p className="mt-2 text-sm">
              HTTP Basic username:{" "}
              <code className="break-all">{credential.id}</code>
            </p>
          </CardContent>
        </Card>
      ) : null}
      {events.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent Axis events</CardTitle>
            <CardDescription>
              Camera-supplied observations are retained for seven days. Images
              use application storage. Thumbnails show the latest observation
              for each passage.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {events.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center gap-4 border-b pb-3"
              >
                {entry.thumbnail_path ? (
                  <Image
                    unoptimized
                    width={200}
                    height={150}
                    className="max-h-24 w-auto object-contain"
                    src={`/images/${entry.thumbnail_path.replaceAll("\\", "/")}`}
                    alt={`Plate ${entry.event.plate}`}
                  />
                ) : null}
                {entry.scene_thumbnail_path ? (
                  <Image
                    unoptimized
                    width={200}
                    height={150}
                    className="max-h-24 w-auto object-contain"
                    src={`/images/${entry.scene_thumbnail_path.replaceAll("\\", "/")}`}
                    alt="Camera-supplied scene"
                  />
                ) : null}
                <div className="text-sm">
                  <p className="font-semibold">
                    {entry.event.plate} · {entry.event.state}
                  </p>
                  <p>
                    {entry.event.direction} · {entry.transport.toUpperCase()} ·{" "}
                    {entry.status}
                  </p>
                  <p>{date(entry.event.timestamp)}</p>
                  <p>
                    {entry.event.metadata?.region}{" "}
                    {entry.event.metadata?.country}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Recognition source and recording source are separate. Axis recognition
        can be used alongside Blue Iris recording and playback.{" "}
        <Link className="text-primary underline" href="/settings/blue-iris">
          Configure Blue Iris
        </Link>
      </p>
    </div>
  );
}

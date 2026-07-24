"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { BellRing, Eye, Pencil, Plus, X } from "lucide-react";

import { addDBPlate, alterPlateFlag } from "@/app/actions";
import { useAccess } from "@/components/auth/AccessProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const PRIORITIES = ["low", "normal", "high", "critical"];

function priorityVariant(priority) {
  return priority === "critical" ? "destructive" : "outline";
}

export function FlaggedPlatesTable({ initialData }) {
  const { can } = useAccess();
  const canReview = can("plate.review");
  const [data, setData] = useState(initialData);
  const [open, setOpen] = useState(false);
  const [editingPlate, setEditingPlate] = useState(null);
  const [plateNumber, setPlateNumber] = useState("");
  const [monitorReason, setMonitorReason] = useState("");
  const [monitorPriority, setMonitorPriority] = useState("normal");
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => setData(initialData), [initialData]);

  const formatDate = (value, empty) =>
    value ? new Date(value).toLocaleString() : empty;

  const closeEditor = () => {
    setOpen(false);
    setEditingPlate(null);
    setPlateNumber("");
    setMonitorReason("");
    setMonitorPriority("normal");
    setMessage(null);
  };

  const openEditor = (plate = null) => {
    setEditingPlate(plate);
    setPlateNumber(plate?.plate_number || "");
    setMonitorReason(plate?.monitor_reason || "");
    setMonitorPriority(plate?.monitor_priority || "normal");
    setMessage(null);
    setOpen(true);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const normalizedPlate = plateNumber.trim().toUpperCase();
    if (!normalizedPlate || normalizedPlate.length > 10) {
      setMessage("Enter a plate number of 10 characters or fewer.");
      return;
    }

    startTransition(async () => {
      const result = editingPlate
        ? await (async () => {
            const formData = new FormData();
            formData.set("plateNumber", editingPlate.plate_number);
            formData.set("flagged", "true");
            formData.set("monitorReason", monitorReason);
            formData.set("monitorPriority", monitorPriority);
            return alterPlateFlag(formData);
          })()
        : await addDBPlate(normalizedPlate, true, {
            reason: monitorReason,
            priority: monitorPriority,
          });

      if (!result.success) {
        setMessage(result.error || "Unable to save monitoring details.");
        return;
      }

      setData((current) => {
        if (editingPlate) {
          return current.map((plate) =>
            plate.plate_number === editingPlate.plate_number
              ? {
                  ...plate,
                  monitor_reason: monitorReason.trim() || null,
                  monitor_priority: monitorPriority,
                }
              : plate
          );
        }
        if (current.some((plate) => plate.plate_number === normalizedPlate)) {
          return current.map((plate) =>
            plate.plate_number === normalizedPlate
              ? {
                  ...plate,
                  monitor_reason: monitorReason.trim() || null,
                  monitor_priority: monitorPriority,
                }
              : plate
          );
        }
        return [
          {
            plate_number: normalizedPlate,
            name: null,
            notes: null,
            occurrence_count: 0,
            last_seen_at: null,
            tags: [],
            monitor_reason: monitorReason.trim() || null,
            monitor_priority: monitorPriority,
            monitored_at: new Date().toISOString(),
          },
          ...current,
        ];
      });
      closeEditor();
    });
  };

  const handleRemove = (plateNumberToRemove) => {
    const formData = new FormData();
    formData.set("plateNumber", plateNumberToRemove);
    formData.set("flagged", "false");

    startTransition(async () => {
      const result = await alterPlateFlag(formData);
      if (result.success) {
        setData((current) =>
          current.filter((plate) => plate.plate_number !== plateNumberToRemove)
        );
      }
    });
  };

  return (
    <>
      <div className="mb-4 flex gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 text-sm">
        <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
        <div>
          <p className="font-medium text-blue-700 dark:text-blue-300">
            Monitored Plates works with unified rules
          </p>
          <p className="mt-1 text-muted-foreground">
            Record why a vehicle matters and assign an operator-facing priority.
            A unified rule using the monitored-plate condition controls cameras
            and delivery channels. Review rule status in{" "}
            <Link href="/notifications" className="underline underline-offset-4">
              Notifications
            </Link>
            .
          </p>
        </div>
      </div>

      <Card className="dark:bg-[#0e0e10]">
        <CardContent className="py-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plate</TableHead>
                <TableHead>Known Name / Tags</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Monitoring Since</TableHead>
                <TableHead>Last Seen</TableHead>
                <TableHead className="text-right">Reads</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center">
                    No monitored plates found
                  </TableCell>
                </TableRow>
              ) : (
                data.map((plate) => (
                  <TableRow key={plate.plate_number}>
                    <TableCell className="font-mono font-medium">
                      <Link
                        href={`/live_feed?search=${encodeURIComponent(plate.plate_number)}&matchMode=off`}
                        className="text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
                      >
                        {plate.plate_number}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div>{plate.name || "—"}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {plate.tags?.map((tag) => (
                          <Badge
                            key={tag.name}
                            variant="secondary"
                            className="px-2 py-0.5 text-xs"
                            style={{ backgroundColor: tag.color, color: "#fff" }}
                          >
                            {tag.name}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={priorityVariant(plate.monitor_priority)}
                        className="capitalize"
                      >
                        {plate.monitor_priority || "normal"}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[260px] whitespace-normal text-sm text-muted-foreground">
                      {plate.monitor_reason || "No reason recorded"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDate(plate.monitored_at, "Previously monitored")}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDate(plate.last_seen_at, "No reads yet")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {plate.occurrence_count || 0}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" asChild>
                          <Link
                            href={`/live_feed?search=${encodeURIComponent(plate.plate_number)}&matchMode=off`}
                          >
                            <Eye className="mr-2 h-4 w-4" /> Reads
                          </Link>
                        </Button>
                        {canReview && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditor(plate)}
                            disabled={isPending}
                          >
                            <Pencil className="mr-2 h-4 w-4" /> Edit
                          </Button>
                        )}
                        {canReview && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemove(plate.plate_number)}
                            disabled={isPending}
                          >
                            <X className="mr-2 h-4 w-4" /> Stop
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canReview && (
        <div className="mt-4 flex items-center justify-end">
          <Dialog
            open={open}
            onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : closeEditor())}
          >
            <DialogTrigger asChild>
              <Button onClick={() => openEditor()}>
                <Plus className="mr-2 h-4 w-4" /> Monitor a Plate
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[480px]">
              <DialogHeader>
                <DialogTitle>
                  {editingPlate ? "Edit Monitoring Details" : "Monitor a Plate"}
                </DialogTitle>
                <DialogDescription>
                  Record why this plate matters and how prominently operators
                  should see it.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit}>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="monitored-plate-number">Plate Number</Label>
                    <Input
                      id="monitored-plate-number"
                      value={plateNumber}
                      onChange={(event) =>
                        setPlateNumber(event.target.value.toUpperCase())
                      }
                      placeholder="ABC123"
                      maxLength={10}
                      disabled={isPending || Boolean(editingPlate)}
                      autoFocus={!editingPlate}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="monitor-priority">Priority</Label>
                    <select
                      id="monitor-priority"
                      value={monitorPriority}
                      onChange={(event) => setMonitorPriority(event.target.value)}
                      className="h-10 rounded-md border bg-background px-3 text-sm"
                      disabled={isPending}
                    >
                      {PRIORITIES.map((priority) => (
                        <option key={priority} value={priority}>
                          {priority[0].toUpperCase() + priority.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="monitor-reason">Reason</Label>
                    <Textarea
                      id="monitor-reason"
                      value={monitorReason}
                      onChange={(event) => setMonitorReason(event.target.value)}
                      placeholder="Why should operators monitor this vehicle?"
                      maxLength={500}
                      disabled={isPending}
                    />
                  </div>
                  {message && <p className="text-sm text-destructive">{message}</p>}
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={closeEditor}
                    disabled={isPending}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isPending || !plateNumber.trim()}>
                    {isPending
                      ? "Saving..."
                      : editingPlate
                        ? "Save Details"
                        : "Monitor Plate"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </>
  );
}

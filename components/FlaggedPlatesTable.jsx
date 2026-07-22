"use client";

import { useState, useEffect, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BellRing, Eye, Plus, X } from "lucide-react";
import { addDBPlate, alterPlateFlag } from "@/app/actions";
import { useAccess } from "@/components/auth/AccessProvider";

export function FlaggedPlatesTable({ initialData }) {
  const { can } = useAccess();
  const [data, setData] = useState(initialData);
  const [open, setOpen] = useState(false);
  const [plateNumber, setPlateNumber] = useState("");
  const [isPending, startTransition] = useTransition();

  const formatLastSeen = (value) => {
    if (!value) return "No reads yet";
    return new Date(value).toLocaleString();
  };

  // Update data when initialData prop changes (after revalidation)
  useEffect(() => {
    setData(initialData);
  }, [initialData]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    const trimmedPlate = plateNumber.trim();
    if (!trimmedPlate) return;

    if (trimmedPlate.length > 10) {
      alert("Plate number cannot exceed 10 characters");
      return;
    }

    startTransition(async () => {
      try {
        const result = await addDBPlate(trimmedPlate.toUpperCase(), true);
        if (result.success) {
          setData((prev) => {
            const normalizedPlate = trimmedPlate.toUpperCase();
            if (prev.some((plate) => plate.plate_number === normalizedPlate)) {
              return prev;
            }
            return [
              {
                plate_number: normalizedPlate,
                name: null,
                notes: null,
                occurrence_count: 0,
                last_seen_at: null,
                tags: [],
              },
              ...prev,
            ];
          });
          setPlateNumber("");
          setOpen(false);
        }
      } catch (error) {
        console.error("Error adding flagged plate:", error);
      }
    });
  };

  const handleRemove = (plateNumberToRemove) => {
    const formData = new FormData();
    formData.append("plateNumber", plateNumberToRemove);
    formData.append("flagged", "false");

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
            Watchlist is integrated with unified rules
          </p>
          <p className="mt-1 text-muted-foreground">
            Adding a plate here marks it as watchlisted. A unified notification
            rule with the Watchlist condition decides which cameras and delivery
            channels should act when that plate is read.
          </p>
        </div>
      </div>

      <Card className="mt-4 sm:mt-0 dark:bg-[#0e0e10]">
        <CardContent className="py-4 ">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plate Number</TableHead>
                <TableHead>Known Name</TableHead>
                <TableHead>Last Seen</TableHead>
                <TableHead className="text-right">Reads</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    No watchlist plates found
                  </TableCell>
                </TableRow>
              ) : (
                data.map((plate) => (
                  <TableRow key={plate.plate_number}>
                    <TableCell className="font-medium font-mono">
                      <Link
                        href={`/live_feed?search=${encodeURIComponent(plate.plate_number)}&matchMode=off`}
                        className="text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
                      >
                        {plate.plate_number}
                      </Link>
                    </TableCell>
                    <TableCell>{plate.name || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatLastSeen(plate.last_seen_at)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {plate.occurrence_count || 0}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {plate.tags?.length > 0 ? (
                          plate.tags.map((tag) => (
                            <Badge
                              key={tag.name}
                              variant="secondary"
                              className="text-xs py-0.5 px-2"
                              style={{
                                backgroundColor: tag.color,
                                color: "#fff",
                              }}
                            >
                              {tag.name}
                            </Badge>
                          ))
                        ) : (
                          <div className="text-sm text-gray-500 dark:text-gray-400 italic">
                            No tags
                          </div>
                        )}
                      </div>
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
                        {can("plate.review") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemove(plate.plate_number)}
                            disabled={isPending}
                          >
                            <X className="mr-2 h-4 w-4" /> Remove
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

      {can("plate.review") && (
      <div className="flex justify-end items-center mt-4">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add to Watchlist
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Add to Watchlist</DialogTitle>
              <DialogDescription>
                Add a plate number for unified Watchlist rules to monitor.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit}>
              <div className="grid gap-4 py-4">
                <div className="grid w-full items-center gap-2">
                  <Label htmlFor="plate-number">Plate Number</Label>
                  <Input
                    id="plate-number"
                    value={plateNumber}
                    onChange={(e) => setPlateNumber(e.target.value)}
                    onBlur={(e) => setPlateNumber(e.target.value.toUpperCase())}
                    className="font-mono text-base p-2 h-10 w-full uppercase"
                    placeholder="Enter Plate Number"
                    maxLength={10}
                    disabled={isPending}
                    autoFocus
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isPending || !plateNumber.trim()}
                >
                  {isPending ? "Adding..." : "Add to Watchlist"}
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

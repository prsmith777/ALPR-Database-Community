// components/PlateDialog.js
"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useRouter } from "next/navigation";

export default function PlateDialog({ plate, history, open, onOpenChange }) {
  const [isEditing, setIsEditing] = useState(false);
  const router = useRouter();

  async function handleSave(e) {
    e.preventDefault();
    const formData = new FormData(e.target);

    await fetch("/api/plates/known", {
      method: "POST",
      body: JSON.stringify({
        plateNumber: plate.plate_number,
        name: formData.get("name"),
        isFlagged: formData.get("flagged") === "on",
        notes: formData.get("notes"),
      }),
    });

    setIsEditing(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Plate Details: {plate.plate_number}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="history">
          <TabsList>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
          </TabsList>
          <TabsContent value="history">
            <div className="max-h-[500px] overflow-y-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Location</th>
                    <th>Camera</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((read) => (
                    <tr key={read.id}>
                      <td>{new Date(read.timestamp).toLocaleString()}</td>
                      <td>{read.location || "-"}</td>
                      <td>{read.camera_id || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>
          <TabsContent value="details">
            <form onSubmit={handleSave}>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Known As</label>
                  <Input
                    name="name"
                    defaultValue={plate.known_name}
                    disabled={!isEditing}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Notes</label>
                  <Textarea
                    name="notes"
                    defaultValue={plate.notes}
                    disabled={!isEditing}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    name="flagged"
                    defaultChecked={plate.is_flagged}
                    disabled={!isEditing}
                  />
                  <label>Flag this plate</label>
                </div>
                {isEditing ? (
                  <div className="flex gap-2">
                    <Button type="submit">Save</Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIsEditing(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button type="button" onClick={() => setIsEditing(true)}>
                    Edit
                  </Button>
                )}
              </div>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import PlateMatchModeSelect from "@/components/PlateMatchModeSelect";
import {
  DEFAULT_PLATE_MATCHING_SETTINGS,
  evaluatePlateMatch,
  normalizePlateMatchingSettings,
} from "@/lib/plate-matching.mjs";

const PROFILE_DETAILS = {
  strict: "Best when false positives must be rare.",
  balanced: "Recommended for everyday searches.",
  broad: "Useful when OCR quality is poor; review results carefully.",
};

function DifferenceSelect({ id, value, onValueChange }) {
  return (
    <Select value={String(value)} onValueChange={(next) => onValueChange(Number(next))}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        {[0, 1, 2].map((count) => (
          <SelectItem key={count} value={String(count)}>
            {count === 0 ? "None" : `${count} character${count === 1 ? "" : "s"}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function PlateMatchingSettings({ initialSettings }) {
  const [settings, setSettings] = useState(() =>
    normalizePlateMatchingSettings(initialSettings)
  );
  const [ocrGroupsText, setOcrGroupsText] = useState(() =>
    normalizePlateMatchingSettings(initialSettings).ocrGroups.join(", ")
  );
  const [testSearch, setTestSearch] = useState("7MLG803");
  const [testCandidate, setTestCandidate] = useState("7ML6803");
  const [testMode, setTestMode] = useState("default");

  const updateProfile = (profile, changes) => {
    setSettings((current) => ({
      ...current,
      profiles: {
        ...current.profiles,
        [profile]: { ...current.profiles[profile], ...changes },
      },
    }));
  };

  const commitOcrGroups = () => {
    const next = normalizePlateMatchingSettings({
      ...settings,
      ocrGroups: ocrGroupsText.split(",").map((group) => group.trim()),
    });
    setSettings(next);
    setOcrGroupsText(next.ocrGroups.join(", "));
  };

  const resetDefaults = () => {
    const next = normalizePlateMatchingSettings(DEFAULT_PLATE_MATCHING_SETTINGS);
    setSettings(next);
    setOcrGroupsText(next.ocrGroups.join(", "));
  };

  const result = evaluatePlateMatch(
    testSearch,
    testCandidate,
    testMode,
    settings
  );

  return (
    <div className="space-y-6">
      <input type="hidden" name="plateMatching" value={JSON.stringify(settings)} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-foreground mb-2">Plate Matching</h2>
          <p className="max-w-3xl text-muted-foreground">
            Configure the shared fuzzy-matching profiles used by Recognition Feed,
            Plate Database, and Downloads. Standard exact and partial searches still
            work when fuzzy matching is off.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={resetDefaults}>
          <RotateCcw className="mr-2 h-4 w-4" /> Reset defaults
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle>Site defaults</CardTitle></CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="default-match-mode">Default search profile</Label>
            <Select
              value={settings.defaultMode}
              onValueChange={(defaultMode) => setSettings((current) => ({ ...current, defaultMode }))}
            >
              <SelectTrigger id="default-match-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="strict">Strict</SelectItem>
                <SelectItem value="balanced">Balanced (recommended)</SelectItem>
                <SelectItem value="broad">Broad</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Pages set to “Use default” follow this profile.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="minimum-match-characters">Minimum characters for fuzzy matching</Label>
            <Select
              value={String(settings.minimumCharacters)}
              onValueChange={(value) =>
                setSettings((current) => ({ ...current, minimumCharacters: Number(value) }))
              }
            >
              <SelectTrigger id="minimum-match-characters"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[3, 4, 5, 6, 7, 8].map((count) => (
                  <SelectItem key={count} value={String(count)}>{count}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Shorter searches use standard matching only, which limits false positives.
            </p>
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="ocr-groups">OCR-equivalent character groups</Label>
            <Input
              id="ocr-groups"
              value={ocrGroupsText}
              onChange={(event) => setOcrGroupsText(event.target.value.toUpperCase())}
              onBlur={commitOcrGroups}
              placeholder="0ODQ, 1I, 2Z, 5S, 8B, 6G"
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated groups tell the matcher which characters the camera commonly confuses.
              A character may appear in only one group.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {Object.entries(settings.profiles).map(([name, profile]) => (
          <Card key={name}>
            <CardHeader>
              <CardTitle className="capitalize">{name}</CardTitle>
              <p className="text-sm text-muted-foreground">{PROFILE_DETAILS[name]}</p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor={`${name}-ordinary`}>Ordinary differences</Label>
                <DifferenceSelect
                  id={`${name}-ordinary`}
                  value={profile.ordinaryDifferences}
                  onValueChange={(ordinaryDifferences) => updateProfile(name, { ordinaryDifferences })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${name}-ocr`}>OCR-equivalent differences</Label>
                <DifferenceSelect
                  id={`${name}-ocr`}
                  value={profile.ocrDifferences}
                  onValueChange={(ocrDifferences) => updateProfile(name, { ocrDifferences })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor={`${name}-insert-delete`} className="font-normal">Allow added or missing characters</Label>
                <Switch
                  id={`${name}-insert-delete`}
                  checked={profile.allowInsertDelete}
                  onCheckedChange={(allowInsertDelete) => updateProfile(name, { allowInsertDelete })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor={`${name}-transposition`} className="font-normal">Allow adjacent swapped characters</Label>
                <Switch
                  id={`${name}-transposition`}
                  checked={profile.allowTransposition}
                  onCheckedChange={(allowTransposition) => updateProfile(name, { allowTransposition })}
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Test the profiles</CardTitle>
          <p className="text-sm text-muted-foreground">
            Compare a search with a stored plate before saving these settings.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="match-test-search">Search</Label>
              <Input id="match-test-search" value={testSearch} onChange={(event) => setTestSearch(event.target.value.toUpperCase())} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="match-test-candidate">Stored plate</Label>
              <Input id="match-test-candidate" value={testCandidate} onChange={(event) => setTestCandidate(event.target.value.toUpperCase())} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="match-test-mode">Profile</Label>
              <PlateMatchModeSelect
                id="match-test-mode"
                value={testMode}
                onValueChange={setTestMode}
                settings={settings}
              />
            </div>
          </div>
          <div className={`rounded-md border p-4 ${result.matched ? "border-green-500/40 bg-green-500/10" : "border-amber-500/40 bg-amber-500/10"}`}>
            <p className="font-medium">{result.matched ? "Match" : "No match"}</p>
            <p className="mt-1 text-sm text-muted-foreground">{result.reason}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

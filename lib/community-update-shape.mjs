export const COMMUNITY_UPDATE_OPERATIONS = Object.freeze([
  "check",
  "update",
  "validate",
  "accept",
  "rollback",
  "cleanup",
]);

export function confirmationForCommunityUpdate(operation, target = null) {
  switch (operation) {
    case "update": return target ? `INSTALL ${target}` : "";
    case "accept": return "I COMPLETED THE MANUAL CHECKS";
    case "rollback": return "ROLL BACK AND DISCARD NEW WRITES";
    case "cleanup": return "DELETE THE ROLLBACK COPY";
    default: return "";
  }
}

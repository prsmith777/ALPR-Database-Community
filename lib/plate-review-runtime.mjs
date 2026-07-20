import { getPool } from "@/lib/db";
import { PlateReviewRepository } from "@/lib/plate-review-repository.mjs";

let repository;

export function getPlateReviewRepository() {
  if (!repository) {
    repository = new PlateReviewRepository({ getPool });
  }
  return repository;
}

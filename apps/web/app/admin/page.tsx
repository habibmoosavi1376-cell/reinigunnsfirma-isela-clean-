import { redirect } from "next/navigation";
import { requireAdminArea } from "@/lib/server/guards";

export default async function AdminIndexPage() {
  await requireAdminArea();
  redirect("/admin/dashboard");
}

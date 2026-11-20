import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminShell } from "../../../components/admin/AdminShell";
import { ReportsTable } from "../../../components/admin/ReportsTable";
import { getDict } from "../../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return { title: en.admin.metaTitle, robots: { index: false, follow: false } };
}

/** Admin: the feedback reports from the web and the app. */
export default function AdminReportsPage() {
  return (
    <AdminShell>
      <Suspense>
        <ReportsTable />
      </Suspense>
    </AdminShell>
  );
}

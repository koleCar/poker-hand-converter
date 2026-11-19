import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminShell } from "../../components/admin/AdminShell";
import { UsersTable } from "../../components/admin/UsersTable";
import { getDict } from "../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return { title: en.admin.metaTitle, robots: { index: false, follow: false } };
}

/** Admin: every account (`20271119100000_admin.sql`). Client-rendered; the database refuses non-admins. */
export default function AdminPage() {
  return (
    <AdminShell>
      <Suspense>
        <UsersTable />
      </Suspense>
    </AdminShell>
  );
}

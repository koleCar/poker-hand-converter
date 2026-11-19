import type { Metadata } from "next";
import { AdminShell } from "../../../components/admin/AdminShell";
import { WaitlistTable } from "../../../components/admin/WaitlistTable";
import { getDict } from "../../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return { title: en.admin.metaTitle, robots: { index: false, follow: false } };
}

/** Admin: the Pro waitlist (`20271119210000_pro_waitlist.sql`). */
export default function AdminWaitlistPage() {
  return (
    <AdminShell>
      <WaitlistTable />
    </AdminShell>
  );
}

import type { Metadata } from "next";
import { AdminShell } from "../../../../components/admin/AdminShell";
import { UserPage } from "../../../../components/admin/UserPage";
import { getDict } from "../../../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return { title: en.admin.metaTitle, robots: { index: false, follow: false } };
}

/** Admin: one account. */
export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminShell>
      <UserPage id={decodeURIComponent(id)} />
    </AdminShell>
  );
}

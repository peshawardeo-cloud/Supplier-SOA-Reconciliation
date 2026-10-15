"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string };

export function Nav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 overflow-x-auto" aria-label="Main">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              "whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium " +
              (active ? "bg-blue-50 text-blue-800" : "text-slate-600 hover:bg-slate-100")
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

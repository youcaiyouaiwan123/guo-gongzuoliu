"use client";

import {
  Archive,
  BookOpen,
  Bot,
  BotMessageSquare,
  Building2,
  Cable,
  ChartNoAxesCombined,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  Cpu,
  Database,
  FileText,
  Images,
  ScrollText,
  ShieldCheck,
  UserRound,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { navigationGroupKeyForTab, navigationGroupsForRole } from "../constants";
import { log } from "../logger";
import type { NavigationIconName } from "../constants";
import type { Tab } from "../shared-types";

const navigationIcons: Record<NavigationIconName, LucideIcon> = {
  assistant: BotMessageSquare,
  media: Images,
  archive: Archive,
  knowledge: BookOpen,
  agent: Bot,
  workflow: Workflow,
  data: Database,
  organization: Building2,
  monitoring: ChartNoAxesCombined,
  contract: FileText,
  approval: ClipboardCheck,
  model: Cpu,
  connector: Cable,
  permission: ShieldCheck,
  audit: ScrollText,
  users: Users,
  profile: UserRound,
  help: CircleHelp,
};

export interface SidebarNavigationProps {
  activeTab: Tab;
  isAdmin: boolean;
  onSelect: (tab: Tab) => void;
}

export default function SidebarNavigation({ activeTab, isAdmin, onSelect }: SidebarNavigationProps) {
  const activeGroupKey = navigationGroupKeyForTab(activeTab);
  const [openOverride, setOpenOverride] = useState<{ activeTab: Tab; groupKey: string | null } | null>(null);
  const openGroupKey = openOverride?.activeTab === activeTab ? openOverride.groupKey : activeGroupKey;
  const groups = navigationGroupsForRole(isAdmin);

  return <nav className="sidebarNav" aria-label="主导航">
    {groups.map(group => {
      const expanded = openGroupKey === group.key;
      const hasActiveItem = group.items.some(([tab]) => tab === activeTab);
      const contentId = `sidebar-group-${group.key}`;

      return <div className={`navGroup ${hasActiveItem ? "hasActive" : ""}`} data-group={group.key} data-expanded={expanded} key={group.key}>
        <button
          className="navGroupToggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setOpenOverride({ activeTab, groupKey: expanded ? null : group.key })}
        >
          <span>{group.label}</span>
          <ChevronDown className="navGroupChevron" aria-hidden="true" />
        </button>
        <div className="navGroupItems" id={contentId}>
          {group.items.map(([tab, icon, label]) => {
            const Icon = navigationIcons[icon];
            return <button
              className={`navItem ${activeTab === tab ? "active" : ""}`}
              type="button"
              data-tab={tab}
              aria-current={activeTab === tab ? "page" : undefined}
              onClick={() => onSelect(tab)}
              key={tab}
            >
              <Icon className="navIcon" aria-hidden="true" />
              <span>{label}</span>
            </button>;
          })}
        </div>
      </div>;
    })}
  </nav>;
}

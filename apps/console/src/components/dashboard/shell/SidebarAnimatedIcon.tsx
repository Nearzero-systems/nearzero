import {
	BlocksIcon,
	BoxesIcon,
	GlobeIcon,
	LayoutGridIcon,
	LoaderCircleIcon,
	RocketIcon,
	TrendingUpIcon,
	type BlocksIconHandle,
	type BoxesIconHandle,
	type GlobeIconHandle,
	type LayoutGridIconHandle,
	type LoaderCircleIconHandle,
	type RocketIconHandle,
	type TrendingUpIconHandle,
} from "@animateicons/react/lucide";
import { useEffect, useRef } from "react";
import type { ComponentType, RefAttributes } from "react";
import type { SidebarAnimatedIconName } from "./sidebarAnimatedIcons";

type IconHandle = {
	startAnimation: () => void;
	stopAnimation: () => void;
};

type AnimatedIconComponent = ComponentType<
	{
		size?: number;
		color?: string;
		isAnimated?: boolean;
		duration?: number;
		className?: string;
	} & RefAttributes<IconHandle>
>;

const SIDEBAR_ANIMATED_ICONS = {
	projects: LayoutGridIcon,
	deployments: RocketIcon,
	schedules: LoaderCircleIcon,
	tasks: LoaderCircleIcon,
	requests: TrendingUpIcon,
	analytics: TrendingUpIcon,
	server: BoxesIcon,
	domains: GlobeIcon,
	cluster: BlocksIcon,
} satisfies Record<SidebarAnimatedIconName, AnimatedIconComponent>;

interface SidebarAnimatedIconProps {
	name: SidebarAnimatedIconName;
	className?: string;
}

export default function SidebarAnimatedIcon({
	name,
	className = "inline-flex size-4 shrink-0 text-current",
}: SidebarAnimatedIconProps) {
	const Icon = SIDEBAR_ANIMATED_ICONS[name];
	const iconRef = useRef<
		| LayoutGridIconHandle
		| RocketIconHandle
		| LoaderCircleIconHandle
		| TrendingUpIconHandle
		| BoxesIconHandle
		| GlobeIconHandle
		| BlocksIconHandle
		| null
	>(null);
	const wrapRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		const link = wrapRef.current?.closest("a, summary");
		if (!link) return;

		const start = () => iconRef.current?.startAnimation();
		const stop = () => iconRef.current?.stopAnimation();

		link.addEventListener("mouseenter", start);
		link.addEventListener("mouseleave", stop);
		link.addEventListener("focusin", start);
		link.addEventListener("focusout", stop);

		return () => {
			link.removeEventListener("mouseenter", start);
			link.removeEventListener("mouseleave", stop);
			link.removeEventListener("focusin", start);
			link.removeEventListener("focusout", stop);
		};
	}, []);

	return (
		<span
			ref={wrapRef}
			className={`nz-sidebar-animated-icon ${className}`.trim()}
		>
			<Icon
				ref={iconRef}
				size={16}
				color="currentColor"
				isAnimated={false}
			/>
		</span>
	);
}

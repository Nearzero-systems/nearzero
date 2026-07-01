import * as React from "react";
import {
	Body,
	Button,
	Container,
	Head,
	Heading,
	Hr,
	Html,
	Img,
	Link,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";

interface WelcomeEmailProps {
	firstName: string;
	organizationName: string;
	dashboardLink: string;
	toEmail: string;
}

export const WelcomeEmail = ({
	firstName,
	organizationName,
	dashboardLink,
	toEmail,
}: WelcomeEmailProps) => {
	const previewText = `Welcome to Nearzero, ${firstName}`;
	return (
		<Html>
			<Head />
			<Preview>{previewText}</Preview>
			<Tailwind
				config={{
					theme: {
						extend: {
							colors: {
								brand: "#007291",
							},
						},
					},
				}}
			>
				<Body className="bg-[#f4f4f5] my-auto mx-auto font-sans">
					<Container className="my-[40px] mx-auto max-w-[520px]">
						<Section className="bg-[#09090b] rounded-t-xl px-[40px] py-[32px] text-center">
							<Img
								src="https://raw.githubusercontent.com/nearzero/website/refs/heads/main/apps/docs/public/logo-nearzero-blackpng.png"
								width="190"
								height="120"
								alt="Nearzero"
								className="my-0 mx-auto"
							/>
						</Section>

						<Section className="bg-white px-[40px] py-[32px]">
							<Heading className="text-[#09090b] text-[22px] font-semibold m-0 mb-[8px]">
								Welcome to Nearzero, {firstName}
							</Heading>
							<Text className="text-[#71717a] text-[14px] leading-[22px] m-0 mb-[24px]">
								Your organization{" "}
								<strong className="text-[#09090b]">{organizationName}</strong> is
								ready. Nearzero helps your team deploy apps, manage services, and
								run infrastructure from one place.
							</Text>

							<Section className="text-center mb-[24px]">
								<Button
									href={dashboardLink}
									className="bg-[#09090b] rounded-lg text-white text-[14px] font-semibold no-underline text-center px-[24px] py-[12px]"
								>
									Open your dashboard
								</Button>
							</Section>

							<Text className="text-[#a1a1aa] text-[13px] leading-[20px] m-0 text-center mb-[16px]">
								If the button above doesn't work, copy and paste this link into your
								browser:
							</Text>
							<Text className="text-[#71717a] text-[12px] leading-[18px] m-0 text-center break-all">
								{dashboardLink}
							</Text>
						</Section>

						<Section className="bg-[#fafafa] rounded-b-xl px-[40px] py-[24px] text-center border-t border-solid border-[#e4e4e7]">
							<Hr className="border border-solid border-[#e4e4e7] my-0 mb-[16px] mx-0 w-full" />
							<Text className="text-[#a1a1aa] text-[12px] leading-[18px] m-0">
								This message was sent to{" "}
								<span className="text-[#71717a]">{toEmail}</span>. Need help? Visit{" "}
								<Link href="https://nearzero.dev" className="text-[#71717a] underline">
									nearzero.dev
								</Link>
								.
							</Text>
						</Section>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
};

export default WelcomeEmail;

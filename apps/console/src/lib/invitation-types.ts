export type InvitationPreview = {
	id: string;
	email: string;
	status: string;
	role: string | null;
	isExpired: boolean;
	userAlreadyExists: boolean;
	organizationId?: string;
	organizationName: string;
	organizationSlug: string;
	organizationLogo: string | null;
	inviterName: string;
	inviterEmail: string;
};

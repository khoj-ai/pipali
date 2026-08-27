// Skill types for the frontend client

export type SkillInfo = {
    name: string;
    description: string;
    location: string;
    visible: boolean;
    /** Ships with the app rather than being the user's own */
    builtin?: boolean;
    /** A builtin skill the user has edited, so app updates no longer land on it */
    modified?: boolean;
};

export type SkillLoadError = {
    path: string;
    message: string;
};

export type SkillsResponse = {
    skills: SkillInfo[];
    errors?: SkillLoadError[];
};

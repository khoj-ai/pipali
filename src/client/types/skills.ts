// Skill types for the frontend client

export type SkillInfo = {
    name: string;
    description: string;
    location: string;
    source: 'global' | 'local';
};

export type SkillLoadError = {
    path: string;
    message: string;
};

export type SkillsResponse = {
    skills: SkillInfo[];
    errors?: SkillLoadError[];
};

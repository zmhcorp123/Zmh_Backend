function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    company: user.company,
    phone: user.phone,
    role: user.role,
    status: user.status,
    isEmailVerified: user.isEmailVerified,
    createdAt: user.createdAt,
  };
}

module.exports = { publicUser };

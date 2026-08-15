from django.urls import include, path
from rest_framework.routers import DefaultRouter
from app.views import PostViewSet, UserViewSet

router = DefaultRouter()
router.register(r"users", UserViewSet, basename="user")
router.register(r"posts", PostViewSet, basename="post")

urlpatterns = [
    path("api/", include(router.urls)),
]
